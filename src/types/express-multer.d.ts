declare namespace Express {
  namespace Multer {
    interface File extends import('multer').File {}
  }
}
