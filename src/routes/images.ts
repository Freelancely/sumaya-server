/**
 * `/api/images/:imageId` — remove one image from a gallery.
 *
 * Top-level rather than nested under the piece: an image id is already unique,
 * and the admin UI deletes from a grid where the piece is implicit.
 */
import { Router } from "express";
import { z } from "zod";

import { RateLimits } from "../http/rateLimit.js";
import { noContent } from "../http/respond.js";
import { mount } from "../http/route.js";
import { getImageService } from "../pieces/index.js";
import { uuidSchema } from "../validation/schemas.js";

export const imagesRouter: Router = Router();

mount(imagesRouter, "/:imageId", {
  DELETE: {
    auth: "required",
    query: z.object({ imageId: uuidSchema }),
    rateLimits: [{ rule: RateLimits.mutation }],
    async handler({ res, requestId, query }) {
      await getImageService().remove(query.imageId);
      noContent(res, requestId);
    },
  },
});
