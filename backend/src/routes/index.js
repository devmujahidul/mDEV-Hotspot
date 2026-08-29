import { Router } from 'express';
import authController from '../controllers/auth.controller.js';
import routersController from '../controllers/routers.controller.js';

const apiRouter = Router();

// Order matters: auth is public, routers requires the httpAuth it bundles.
apiRouter.use(authController);
apiRouter.use(routersController);

export default apiRouter;

