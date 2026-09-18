import { publicationName } from "./provider-canary.mjs";

export function syncAudioSubscriptions(room, listeningPlan) {
  if (!room?.remoteParticipants) {
    throw new Error("a connected LiveKit room is required");
  }

  const desiredTracks = listeningPlan?.tracks ?? [];
  if (!Array.isArray(desiredTracks)) throw new Error("audio plan tracks must be an array");
  const desiredTrackIds = desiredTracks.map(({ trackId }) => trackId);
  if (new Set(desiredTrackIds).size !== desiredTrackIds.length) {
    throw new Error("duplicate audio plan track");
  }
  const desiredTrackIdSet = new Set(desiredTrackIds);

  const subscribed = [];
  const unsubscribed = [];
  const audioPublications = [];

  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.kind !== "audio") {
        continue;
      }
      audioPublications.push(publication);
    }
  }

  for (const desiredTrackId of desiredTrackIds) {
    const matches = audioPublications.filter(
      (publication) => publicationName(publication) === desiredTrackId,
    );
    if (matches.length > 1) {
      throw new Error(`audio plan matched multiple tracks: ${desiredTrackId}`);
    }
  }

  for (const publication of audioPublications) {
    const name = publicationName(publication);
    const shouldSubscribe = desiredTrackIdSet.has(name);
    publication.setSubscribed(shouldSubscribe);
    (shouldSubscribe ? subscribed : unsubscribed).push(name);
  }

  return { subscribed, unsubscribed };
}
