import { config } from "@/config/index";
import { logger } from "@/common/logger";
import { idb } from "@/common/db";
import { redis } from "@/common/redis";

import { AbstractRabbitMqJobHandler } from "@/jobs/abstract-rabbit-mq-job-handler";

import * as AskIndex from "@/elasticsearch/indexes/asks";
import { elasticsearch } from "@/common/elasticsearch";
import { AskCreatedEventHandler } from "@/elasticsearch/indexes/asks/event-handlers/ask-created";
import { AskEvent } from "@/elasticsearch/indexes/asks/pending-ask-events-queue";

export class BackfillAsksElasticsearchJob extends AbstractRabbitMqJobHandler {
  queueName = "backfill-asks-elasticsearch-queue";
  maxRetries = 10;
  concurrency = 5;
  persistent = true;

  public async process(payload: BackfillAsksElasticsearchJobPayload) {
    if (!payload.cursor) {
      logger.info(
        this.queueName,
        JSON.stringify({
          topic: "debugAskIndex",
          message: `Start. fromTimestamp=${payload.fromTimestamp}, onlyActive=${payload.onlyActive}`,
          payload,
        })
      );
    }

    let nextCursor;
    let query;

    const askEvents: AskEvent[] = [];

    try {
      let continuationFilter = "";
      let fromTimestampFilter = "";
      let orderKindFilter = "";

      const limit = Number(await redis.get(`${this.queueName}-limit`)) || 100;

      if (payload.cursor) {
        continuationFilter = `AND (orders.updated_at, orders.id) > (to_timestamp($/updatedAt/), $/id/)`;
      }

      if (payload.fromTimestamp) {
        fromTimestampFilter = `AND (orders.updated_at) > (to_timestamp($/fromTimestamp/))`;
      }

      if (payload.orderKind) {
        orderKindFilter = `AND orders.kind = $/orderKind/`;
      }

      query = `
            ${AskCreatedEventHandler.buildBaseQuery(payload.onlyActive)}
              ${continuationFilter}
              ${fromTimestampFilter}
              ${orderKindFilter}
              ORDER BY updated_at, id
              LIMIT $/limit/;
          `;

      const rawResults = await idb.manyOrNone(query, {
        fromTimestamp: payload.fromTimestamp,
        orderKind: payload.orderKind,
        updatedAt: payload.cursor?.updatedAt,
        id: payload.cursor?.id,
        limit,
      });

      if (rawResults.length) {
        for (const rawResult of rawResults) {
          try {
            const eventHandler = new AskCreatedEventHandler(rawResult.order_id);
            const askDocument = eventHandler.buildDocument(rawResult);

            askEvents.push({
              kind: "index",
              info: { id: eventHandler.getAskId(), document: askDocument },
            } as AskEvent);
          } catch (error) {
            logger.error(
              this.queueName,
              JSON.stringify({
                topic: "debugAskIndex",
                message: `Error generating ask document. error=${error}`,
                error,
                payload,
                rawResult,
              })
            );
          }
        }

        const lastResult = rawResults[rawResults.length - 1];

        nextCursor = {
          updatedAt: lastResult.updated_ts,
          id: lastResult.order_id,
        };
      }
    } catch (error) {
      logger.error(
        this.queueName,
        JSON.stringify({
          topic: "debugAskIndex",
          message: `Error generating ask documents. error=${error}`,
          error,
          payload,
          query,
        })
      );

      throw error;
    }

    if (askEvents.length) {
      const bulkIndexOps = askEvents
        .filter((askEvent) => askEvent.kind == "index")
        .flatMap((askEvent) => [
          { index: { _index: AskIndex.getIndexName(), _id: askEvent.info.id } },
          askEvent.info.document,
        ]);
      const bulkDeleteOps = askEvents
        .filter((askEvent) => askEvent.kind == "delete")
        .flatMap((askEvent) => ({
          delete: { _index: AskIndex.getIndexName(), _id: askEvent.info.id },
        }));

      let bulkIndexOpsResponse;

      if (bulkIndexOps.length) {
        bulkIndexOpsResponse = await elasticsearch.bulk({
          body: bulkIndexOps,
        });
      }

      let bulkDeleteOpsResponse;

      if (bulkDeleteOps.length) {
        bulkDeleteOpsResponse = await elasticsearch.bulk({
          body: bulkDeleteOps,
        });
      }

      logger.info(
        this.queueName,
        JSON.stringify({
          topic: "debugAskIndex",
          message: `Indexed ${bulkIndexOps.length / 2} asks. Deleted ${bulkDeleteOps.length} asks`,
          payload,
          nextCursor,
          indexName: AskIndex.getIndexName(),
          bulkIndexOpsResponseHasErrors: bulkIndexOpsResponse?.errors,
          bulkIndexOpsResponse: bulkIndexOpsResponse?.errors ? bulkIndexOpsResponse : undefined,
          bulkDeleteOpsResponseHasErrors: bulkDeleteOpsResponse?.errors,
          bulkDeleteOpsResponse: bulkDeleteOpsResponse?.errors ? bulkDeleteOpsResponse : undefined,
        })
      );

      await this.addToQueue(
        payload.fromTimestamp,
        payload.orderKind,
        payload.onlyActive,
        nextCursor
      );
    }
  }

  public async addToQueue(
    fromTimestamp?: number,
    orderKind?: string,
    onlyActive?: boolean,
    cursor?: {
      updatedAt: string;
      id: string;
    }
  ) {
    if (!config.doElasticsearchWork) {
      return;
    }

    await this.send(
      {
        payload: {
          fromTimestamp,
          orderKind,
          onlyActive,
          cursor,
        },
      },
      1000
    );
  }
}

export const backfillAsksElasticsearchJob = new BackfillAsksElasticsearchJob();

export type BackfillAsksElasticsearchJobPayload = {
  fromTimestamp?: number;
  onlyActive?: boolean;
  orderKind?: string;
  cursor?: {
    updatedAt: string;
    id: string;
  };
};
