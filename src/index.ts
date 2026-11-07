// The function's entry point, shipped with `telnyx-edge` (npm run deploy).
// The runtime imports the actor class from here by name; every HTTP request
// goes through the v1 router.

import { AiDigest } from "./agent.ts";
import { route, type RouterEnv } from "./router.ts";

export { AiDigest };

export default {
  fetch(req: Request, env: RouterEnv): Promise<Response> {
    return route(req, env);
  },
};
