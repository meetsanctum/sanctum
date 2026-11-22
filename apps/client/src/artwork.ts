import { blobHashPattern } from "@meetsanctum/app-sdk";
import { useEffect, useState } from "react";

import { artworkColour } from "./artwork-colour";
import { coreFetch } from "./core-fetch";

// The picture of what a media player plays, which its state names by hash:
// fetched from the core with the client's token, as every core call is,
// shown from memory, and with the colour the veil takes from it
// (artwork-colour.ts). A hash names the same picture for good, so each is
// fetched once and kept for the few that were shown last; one the core no
// longer has is tried again when it's next asked for.

export type Artwork = { url: string; colour: string | null };

// How many pictures stay in memory.
const keptPictures = 16;
// How wide the picture is drawn to take its colour, in px.
const sampleSize = 16;

const kept = new Map<string, Promise<Artwork | null>>();

async function colourOf(picture: Blob): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(picture, {
      resizeWidth: sampleSize,
      resizeHeight: sampleSize,
    });
    const canvas = document.createElement("canvas");
    canvas.width = sampleSize;
    canvas.height = sampleSize;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return artworkColour(
      context.getImageData(0, 0, sampleSize, sampleSize).data,
    );
  } catch {
    // A picture the browser can't read keeps the plain veil.
    return null;
  }
}

async function fetchArtwork(hash: string): Promise<Artwork | null> {
  const answer = await coreFetch(`/api/blobs/${hash}`);
  if (!answer.ok) return null;
  const picture = await answer.blob();
  return {
    url: URL.createObjectURL(picture),
    colour: await colourOf(picture),
  };
}

function artworkOf(hash: string) {
  const known = kept.get(hash);
  if (known) {
    // The most recently asked for is kept longest.
    kept.delete(hash);
    kept.set(hash, known);
    return known;
  }
  const loading = fetchArtwork(hash).catch(() => null);
  kept.set(hash, loading);
  void loading.then((artwork) => {
    if (!artwork) kept.delete(hash);
  });
  for (const [oldest, picture] of kept) {
    if (kept.size <= keptPictures) break;
    kept.delete(oldest);
    void picture.then((artwork) => {
      if (artwork) URL.revokeObjectURL(artwork.url);
    });
  }
  return loading;
}

/** The picture a hash names, once it has arrived; null without one. */
export function useArtwork(hash: string | null | undefined): Artwork | null {
  const [shown, setShown] = useState<{
    hash: string;
    artwork: Artwork | null;
  } | null>(null);
  const valid = hash && blobHashPattern.test(hash) ? hash : null;
  useEffect(() => {
    if (!valid) return;
    let isCurrent = true;
    void artworkOf(valid).then((artwork) => {
      if (isCurrent) setShown({ hash: valid, artwork });
    });
    return () => {
      isCurrent = false;
    };
  }, [valid]);
  return valid && shown?.hash === valid ? shown.artwork : null;
}
