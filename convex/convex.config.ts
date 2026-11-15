import bunny from "convex-bunny/convex.config.js";
import workflow from "@convex-dev/workflow/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();

app.use(bunny);
app.use(workflow);

export default app;
