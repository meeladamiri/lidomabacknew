// The public counterpart to admin/faq.routes.ts's resolved-list preview —
// this is what an actual page (currently just /support) calls at render
// time. `home.routes.ts` gets its homepage FAQs the same way, internally;
// this exists because /support isn't composed server-side the way the
// homepage is, so it needs its own small round trip.

import { Router } from "express";
import { asyncHandler } from "@/middleware/asyncHandler";
import { ok } from "@/utils/response";
import { getFaqsForPage } from "./faq.service";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const path = typeof req.query.path === "string" ? req.query.path : "/support";
    return ok(res, { faqs: await getFaqsForPage({ kind: "page", path }) });
  })
);

export default router;
