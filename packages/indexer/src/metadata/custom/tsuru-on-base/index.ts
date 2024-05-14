/* eslint-disable @typescript-eslint/no-unused-vars */

export const fetchToken = async ({ contract, tokenId }: { contract: string; tokenId: string }) => {
  return {
    contract,
    tokenId,
    collection: contract.toLowerCase(),
    slug: "tsuru-on-base",
    name: "JOURNEY by Tsurushima Tatsumi",
    description: "Tsuru embarks on a new journey on Base.",
    imageUrl:
      "https://ipfs.io/ipfs/bafybeihkrcxfoxoksw4hj6kigz7qrmqsmbsyt53lwsctlwpiidd5biclgm/0.png?ext=png",
    mediaUrl: null,
    attributes: [],
  };
};
