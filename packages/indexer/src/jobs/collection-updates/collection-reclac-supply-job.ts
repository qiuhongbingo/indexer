import { redb } from "@/common/db";
import { fromBuffer, toBuffer } from "@/common/utils";
import { AbstractRabbitMqJobHandler } from "@/jobs/abstract-rabbit-mq-job-handler";
import _ from "lodash";
import { getNetworkSettings } from "@/config/network";
import { tokenReclacSupplyJob } from "@/jobs/token-updates/token-reclac-supply-job";
import { recalcTokenCountQueueJob } from "@/jobs/collection-updates/recalc-token-count-queue-job";

export type CollectionResyncBurnedTokensJobPayload = {
  collection: string;
  fromTokenId?: string;
  force?: boolean;
};

export default class CollectionResyncBurnedTokensJob extends AbstractRabbitMqJobHandler {
  queueName = "collection-resync-burned-tokens";
  maxRetries = 1;
  concurrency = 10;
  useSharedChannel = true;

  public async process(payload: CollectionResyncBurnedTokensJobPayload) {
    const { collection, fromTokenId, force } = payload;
    const [contract] = collection.split(":");
    const limit = 5000;
    const continuation = fromTokenId ? `AND tokens.token_id > $/fromTokenId/` : "";

    const query = `
      SELECT contract, token_id
      FROM tokens
      WHERE (contract, token_id) NOT IN (
        SELECT nft_balances.contract, nft_balances.token_id
        FROM nft_balances
        JOIN tokens ON nft_balances.contract = tokens.contract AND nft_balances.token_id = tokens.token_id
        WHERE nft_balances.contract = $/contract/
        AND owner NOT IN ($/burnAddresses:list/)
        AND amount > 0
        AND tokens.collection_id = $/collection/
      )
      ${continuation}
      AND remaining_supply > 0
      AND tokens.contract = $/contract/
      AND tokens.collection_id = $/collection/
      ORDER BY tokens.contract, tokens.token_id
      LIMIT ${limit}
    `;

    const tokens = await redb.manyOrNone(query, {
      collection,
      contract: toBuffer(contract),
      tokenId: fromTokenId,
      mintAddresses: getNetworkSettings().mintAddresses.map((address) => toBuffer(address)),
      limit,
    });

    if (!_.isEmpty(tokens)) {
      await tokenReclacSupplyJob.addToQueue(
        tokens.map((t) => ({ contract: fromBuffer(t.contract), tokenId: t.token_id })),
        0
      );

      if (tokens.length === limit) {
        await this.addToQueue({ collection, fromTokenId: _.last(tokens).token_id, force });
      }

      // Trigger a tokens recalc with a default delay
      await recalcTokenCountQueueJob.addToQueue({ collection });
    }
  }

  public async addToQueue(payload: CollectionResyncBurnedTokensJobPayload, delay = 5 * 60 * 1000) {
    await this.send(
      {
        payload,
        jobId: payload.force ? undefined : `${payload.collection}:${payload.fromTokenId}`,
      },
      payload.force ? 0 : delay
    );
  }
}

export const collectionResyncBurnedTokensJob = new CollectionResyncBurnedTokensJob();
