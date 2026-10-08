import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleTick } from "./handler.ts";

// Custom auth: the body token is checked inside the database against the vault secret. See handler.ts.
Deno.serve((req: Request) => handleTick(req, (name) => Deno.env.get(name), fetch));
