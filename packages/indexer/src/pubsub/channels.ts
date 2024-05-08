export enum Channel {
  ApiKeyUpdated = "api-key-updated",
  FeeRecipientsUpdated = "fee-recipients-updated",
  MetadataReenabled = "metadata-reenabled",
  PauseRabbitConsumerQueue = "pause-rabbit-consumer-queue",
  RateLimitRuleUpdated = "rate-limit-rule-updated",
  ResumeRabbitConsumerQueue = "resume-rabbit-consumer-queue",
  RoutersUpdated = "routers-updated",
  SourcesUpdated = "sources-updated",
}

export enum AllChainsChannel {
  ApiKeyCreated = "api-key-created-all-chains",
  ApiKeyUpdated = "api-key-updated-all-chains",
  PauseRabbitConsumerQueue = "pause-rabbit-consumer-queue-all-chains",
  RateLimitRuleCreated = "rate-limit-rule-created-all-chains",
  RateLimitRuleDeleted = "rate-limit-rule-deleted-all-chains",
  RateLimitRuleUpdated = "rate-limit-rule-updated-all-chains",
  ResumeRabbitConsumerQueue = "resume-rabbit-consumer-queue-all-chains",
}
