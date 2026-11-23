import { blobHashPattern } from "@meetsanctum/app-sdk";
import { useEffect, useState } from "react";

import { artworkColour } from "./artwork-colour";
import { coreFetch, currentCredential } from "./core-fetch";
import { coreBaseUrl } from "./core-url";

// The picture of what a media player plays, which its state names by hash:
// fetched from the core with the client's token, as every core call is,
// shown from memory, and with the colour the veil takes from it
// (artwork-colour.ts). A hash names the same picture for good, so each is
// fetched once and kept for the few that were shown last; one the core no
// longer has is tried again when it's next asked for, and meanwhile is
// missing, as one is whose name isn't a hash.

type Artwork = { url: string; colour: string | null };
type Picture = { blob: Blob; colour: string | null };

// How many pictures stay in memory.
const keptPictures = 16;
// How wide the picture is drawn to take its colour, in px.
const sampleSize = 16;

const kept = new Map<string, Promise<Picture | null>>();
let cacheCredential: ReturnType<typeof currentCredential>;
let cacheHost: string;

async function colourOf(picture: Blob): Promise<string | null> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(picture, {
      resizeWidth: sampleSize,
      resizeHeight: sampleSize,
    });
    const canvas = document.createElement("canvas");
    canvas.width = sampleSize;
    canvas.height = sampleSize;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return artworkColour(
      context.getImageData(0, 0, sampleSize, sampleSize).data,
    );
  } catch {
    // A picture the browser can't read keeps the plain veil.
    return null;
  } finally {
    bitmap?.close();
  }
}

async function fetchArtwork(hash: string): Promise<Picture | null> {
  const answer = await coreFetch(`/api/blobs/${hash}`);
  if (!answer.ok) return null;
  const blob = await answer.blob();
  return { blob, colour: await colourOf(blob) };
}

function pictureOf(hash: string) {
  const credential = currentCredential();
  const host = coreBaseUrl();
  if (cacheCredential !== credential || cacheHost !== host) {
    kept.clear();
    cacheCredential = credential;
    cacheHost = host;
  }
  const known = kept.get(hash);
  if (known) {
    // The most recently asked for is kept longest.
    kept.delete(hash);
    kept.set(hash, known);
    return known;
  }
  const loading = fetchArtwork(hash).catch(() => null);
  kept.set(hash, loading);
  void loading.then((picture) => {
    if (!picture && kept.get(hash) === loading) kept.delete(hash);
  });
  if (kept.size > keptPictures) {
    const oldest = kept.keys().next().value;
    if (oldest !== undefined) kept.delete(oldest);
  }
  return loading;
}

/**
 * The picture a hash names, once it has arrived; "missing" when the core
 * hasn't it to give, or the name isn't a hash; null while it is on its way,
 * or without a hash.
 */
export function useArtwork(
  hash: string | null | undefined,
): Artwork | "missing" | null {
  const [shown, setShown] = useState<{
    hash: string;
    credential: ReturnType<typeof currentCredential>;
    host: string;
    artwork: Artwork | "missing";
  } | null>(null);
  const valid = hash && blobHashPattern.test(hash) ? hash : null;
  const credential = valid ? currentCredential() : null;
  const host = valid ? coreBaseUrl() : null;
  useEffect(() => {
    setShown(null);
    if (!valid || !host) return;
    let isCurrent = true;
    let url: string | undefined;
    void pictureOf(valid).then((picture) => {
      if (!isCurrent) return;
      if (!picture) {
        setShown({ hash: valid, credential, host, artwork: "missing" });
        return;
      }
      // The image can outlive its entry in the shared cache.
      url = URL.createObjectURL(picture.blob);
      setShown({
        hash: valid,
        credential,
        host,
        artwork: { url, colour: picture.colour },
      });
    });
    return () => {
      isCurrent = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [valid, credential, host]);
  if (hash && !valid) return "missing";
  return shown?.hash === valid &&
    shown.credential === credential &&
    shown.host === host
    ? shown.artwork
    : null;
}
