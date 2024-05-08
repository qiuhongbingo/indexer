import { logger } from "@/common/logger";
import { FeeRecipients } from "@/models/fee-recipients";
import { Channel } from "@/pubsub/channels";

export class FeeRecipientsUpdatedEvent {
  public static async handleEvent(message: string) {
    await FeeRecipients.forceDataReload();
    logger.info(Channel.FeeRecipientsUpdated, `Reloaded fee-recipients message=${message}`);
  }
}
