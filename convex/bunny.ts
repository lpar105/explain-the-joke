import { BunnyStorage } from "convex-bunny";

import { components } from "./_generated/api";

function requireBunnyEnv(name: "BUNNY_STORAGE_ZONE" | "BUNNY_API_KEY" | "BUNNY_CDN_HOSTNAME") {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in the Convex environment.`);
  return value;
}

const storageZone = requireBunnyEnv("BUNNY_STORAGE_ZONE");
const apiKey = requireBunnyEnv("BUNNY_API_KEY");
const cdnHostname = requireBunnyEnv("BUNNY_CDN_HOSTNAME");
const region = process.env.BUNNY_REGION ?? "default";

export const bunnyStorage = new BunnyStorage(components.bunny, {
  storageZone,
  apiKey,
  cdnHostname,
  region,
});

export function getBunnyArtifactCdnUrl(key: string) {
  return bunnyStorage.getCdnUrl(key);
}

export function getBunnyStorageZone() {
  return storageZone;
}

export function getBunnyStorageApiKey() {
  return apiKey;
}

export function getBunnyStorageRegion() {
  return region;
}

export function getBunnyStorageHostname(region = getBunnyStorageRegion()) {
  return {
    default: "storage.bunnycdn.com",
    de: "storage.bunnycdn.com",
    ny: "ny.storage.bunnycdn.com",
    la: "la.storage.bunnycdn.com",
    sg: "sg.storage.bunnycdn.com",
    syd: "syd.storage.bunnycdn.com",
    br: "br.storage.bunnycdn.com",
    jh: "jh.storage.bunnycdn.com",
  }[region] ?? "storage.bunnycdn.com";
}

export function getBunnyArtifactStorageUrl(key: string) {
  return `https://${getBunnyStorageHostname()}/${getBunnyStorageZone()}/${key}`;
}
