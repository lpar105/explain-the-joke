/// <reference types="vite/client" />

import { convexTest } from "convex-test";

import bunnySchema from "../../node_modules/convex-bunny/src/component/schema";
import workpoolSchema from "../../node_modules/@convex-dev/workpool/dist/component/schema";
import workflowSchema from "../../node_modules/@convex-dev/workflow/dist/component/schema";
import schema from "../../convex/schema";

export const convexModules = import.meta.glob("../../convex/**/*.ts");
export const bunnyComponentModules = import.meta.glob(
  "../../node_modules/convex-bunny/src/component/**/*.ts",
);
export const workflowComponentModules = import.meta.glob(
  "../../node_modules/@convex-dev/workflow/dist/component/**/*.js",
);
export const workpoolComponentModules = import.meta.glob(
  "../../node_modules/@convex-dev/workpool/dist/component/**/*.js",
);

export function createConvexTest() {
  const t = convexTest(schema, convexModules);
  t.registerComponent("bunny", bunnySchema, bunnyComponentModules);
  t.registerComponent("workflow", workflowSchema, workflowComponentModules);
  t.registerComponent("workflow/workpool", workpoolSchema, workpoolComponentModules);
  return t;
}
