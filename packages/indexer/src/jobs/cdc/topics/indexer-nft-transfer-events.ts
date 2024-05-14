/* eslint-disable @typescript-eslint/no-explicit-any */

import { KafkaEventHandler } from "./KafkaEventHandler";
import {
  WebsocketEventKind,
  WebsocketEventRouter,
} from "@/jobs/websocket-events/websocket-event-router";
import { updateUserCollectionsJob } from "@/jobs/nft-balance-updates/update-user-collections-job";
import { Tokens } from "@/models/tokens";
import { resyncUserCollectionsJob } from "@/jobs/nft-balance-updates/reynsc-user-collections-job";

export class IndexerTransferEventsHandler extends KafkaEventHandler {
  topicName = "indexer.public.nft_transfer_events";

  protected async handleInsert(payload: any, offset: string): Promise<void> {
    if (!payload.after) {
      return;
    }

    await WebsocketEventRouter({
      eventInfo: {
        before: payload.before,
        after: payload.after,
        trigger: "insert",
        offset,
      },
      eventKind: WebsocketEventKind.TransferEvent,
    });

    // Update the user collections
    await updateUserCollectionsJob.addToQueue([
      {
        fromAddress: payload.after.from,
        toAddress: payload.after.to,
        contract: payload.after.address,
        tokenId: payload.after.token_id,
        amount: payload.after.amount,
      },
    ]);
  }

  protected async handleUpdate(payload: any, offset: string): Promise<void> {
    if (!payload.after) {
      return;
    }

    await WebsocketEventRouter({
      eventInfo: {
        before: payload.before,
        after: payload.after,
        trigger: "update",
        offset,
      },
      eventKind: WebsocketEventKind.TransferEvent,
    });

    const isDeleted = payload.before.is_deleted !== payload.after.is_deleted;

    if (isDeleted) {
      const token = await Tokens.getByContractAndTokenId(
        payload.after.address,
        payload.after.token_id
      );

      // If the transfer was marked as deleted resync the user collection token count
      if (token && token.collectionId) {
        await resyncUserCollectionsJob.addToQueue([
          { user: payload.after.from, collectionId: token.collectionId },
          { user: payload.after.to, collectionId: token.collectionId },
        ]);
      }
    }
  }

  protected async handleDelete(): Promise<void> {
    // probably do nothing here
  }
}
