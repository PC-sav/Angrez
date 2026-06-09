import type { User } from "../services/users";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
