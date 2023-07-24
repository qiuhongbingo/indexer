import _ from "lodash";

import { idb, redb } from "@/common/db";
import { redis } from "@/common/redis";
import {
  FeeKind,
  FeeRecipientEntity,
  FeeRecipientEntityParams,
} from "@/models/fee-recipient/fee-recipient-entity";
import { default as entitiesFromJson } from "./feeRecipient.json";
import { Sources } from "@/models/sources";
import { fromBuffer, toBuffer } from "@/common/utils";

export class FeeRecipient {
  private static instance: FeeRecipient;

  public feeRecipientsByAddress: { [address: string]: FeeRecipientEntity };

  private constructor() {
    this.feeRecipientsByAddress = {};
  }

  private async loadData(forceDbLoad = false) {
    // Try to load from cache
    const entitiesCache = await redis.get(FeeRecipient.getCacheKey());
    let entities: FeeRecipientEntityParams[];

    if (_.isNull(entitiesCache) || forceDbLoad) {
      // If no cache is available, then load from the database
      entities = (
        await idb.manyOrNone(
          `
          SELECT
            fee_recipients.source_id,
            fee_recipients.kind,
            fee_recipients.address
          FROM fee_recipients
        `
        )
      ).map((c) => {
        return {
          ...c,
          address: fromBuffer(c.address),
        };
      });

      await redis.set(FeeRecipient.getCacheKey(), JSON.stringify(entities), "EX", 60 * 60 * 24);
    } else {
      // Parse the data
      entities = JSON.parse(entitiesCache);
    }

    for (const entity of entities) {
      const keyId = `${_.toLower(entity.address)}:${entity.kind}`;
      this.feeRecipientsByAddress[keyId] = new FeeRecipientEntity(entity);
    }
  }

  public static getCacheKey() {
    return "fee_recipients_v4";
  }

  public static async getInstance() {
    if (!FeeRecipient.instance) {
      FeeRecipient.instance = new FeeRecipient();
      await FeeRecipient.instance.loadData();
    }

    return FeeRecipient.instance;
  }

  public static async forceDataReload() {
    if (FeeRecipient.instance) {
      await FeeRecipient.instance.loadData(true);
    }
  }

  public static async syncSources() {
    // Make surce the source is loaded
    Sources.getInstance();
    await Sources.syncSources();
    await Sources.forceDataReload();

    _.forEach(entitiesFromJson, (item) => {
      FeeRecipient.addFromJson(item.domain, item.address, item.kind as FeeKind);
    });
  }

  public static async addFromJson(domain: string | null, address: string, kind: FeeKind) {
    try {
      const source = await Sources.getInstance();
      const sourceId = domain ? source.getByDomain(domain)?.id : undefined;
      await idb.none(
        `
        INSERT INTO fee_recipients(
          address,
          source_id,
          kind
        ) VALUES (
          $/address/,
          $/sourceId/,
          $/kind/
        )
        ON CONFLICT (kind, address) DO UPDATE SET
          source_id = $/sourceId/
      `,
        {
          sourceId,
          kind,
          address: toBuffer(address),
        }
      );
    } catch (error) {
      // Ignore errors when loading from JSON
    }
  }

  public async create(address: string, kind: FeeKind, domain: string | null) {
    // It could be the entity already exist
    let entity = await redb.oneOrNone(
      `
      SELECT *
      FROM fee_recipients
      WHERE address = $/address/ AND kind = $/kind/
    `,
      {
        address: toBuffer(address),
        kind,
      }
    );

    if (entity) {
      return new FeeRecipientEntity(entity);
    }

    const source = await Sources.getInstance();
    const sourceId = domain ? source.getByDomain(domain)?.id : undefined;

    entity = await idb.oneOrNone(
      `
        INSERT INTO fee_recipients(
          address,
          source_id,
          kind
        ) VALUES (
          $/address/,
          $/sourceId/,
          $/kind/
        )
        ON CONFLICT (kind, address) DO UPDATE SET source_id = EXCLUDED.source_id
        RETURNING *
      `,
      {
        kind,
        address: toBuffer(address),
        sourceId,
      }
    );

    // Reload the cache
    await FeeRecipient.instance.loadData(true);
    return new FeeRecipientEntity(entity);
  }

  public getByAddress(address: string, kind: FeeKind): FeeRecipientEntity | undefined {
    let entity: FeeRecipientEntity | undefined;

    address = _.toLower(address);
    const keyId = `${address}:${kind}`;
    if (keyId in this.feeRecipientsByAddress) {
      entity = this.feeRecipientsByAddress[keyId];
    }
    return entity;
  }

  public async getOrInsert(
    address: string,
    domain: string,
    kind: FeeKind
  ): Promise<FeeRecipientEntity> {
    let entity: FeeRecipientEntity | undefined;
    entity = this.getByAddress(address, kind);
    if (!entity) {
      entity = await this.create(address, kind, domain);
    }
    return entity;
  }
}
