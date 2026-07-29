import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import professionalsRoutes from '../modules/professionals/professionals.routes.js';
import catalogRoutes from '../modules/catalog/catalog.routes.js';
import importsRoutes from '../modules/imports/imports.routes.js';
import draftsRoutes from '../modules/imports/drafts.routes.js';
import ordersRoutes from '../modules/orders/orders.routes.js';
import filesRoutes from '../modules/files/files.routes.js';
import notificationsRoutes from '../modules/notifications/notifications.routes.js';
import reportsRoutes from '../modules/reports/reports.routes.js';
import publicRoutes from '../modules/public/public.routes.js';
import surveysRoutes from '../modules/surveys/surveys.routes.js';
import billingRoutes from '../modules/billing/billing.routes.js';
import permissionsRoutes from '../modules/permissions/permissions.routes.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// M6 · Portal público (SIN auth) — se monta primero para que ningún
// middleware de autenticación de otros routers lo intercepte.
router.use('/public', publicRoutes);

// M1
router.use('/auth', authRoutes);
// CFG-01
router.use('/professionals', professionalsRoutes);
// M2
router.use('/imports', importsRoutes);
router.use('/drafts', draftsRoutes);
// M3/M4/M5/M7
router.use('/orders', ordersRoutes);
// Descargas / visualización
router.use('/files', filesRoutes);
// M8
router.use('/surveys', surveysRoutes);
// M9
router.use('/precuentas', billingRoutes);
// M11
router.use('/notifications', notificationsRoutes);
// M10
router.use('/reports', reportsRoutes);
// Roles y permisos (Configuración) — matriz de acceso por vista, exclusivo admin
router.use('/permisos', permissionsRoutes);
// Catálogos + Configuración (montado en '/', va al final por su comodín)
router.use('/', catalogRoutes);

export default router;
