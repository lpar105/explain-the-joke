/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as bunny from "../bunny.js";
import type * as bunnyStream from "../bunnyStream.js";
import type * as http from "../http.js";
import type * as setIngest from "../setIngest.js";
import type * as setIngestModal from "../setIngestModal.js";
import type * as sets from "../sets.js";
import type * as workflow from "../workflow.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  bunny: typeof bunny;
  bunnyStream: typeof bunnyStream;
  http: typeof http;
  setIngest: typeof setIngest;
  setIngestModal: typeof setIngestModal;
  sets: typeof sets;
  workflow: typeof workflow;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  bunny: import("convex-bunny/_generated/component.js").ComponentApi<"bunny">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
