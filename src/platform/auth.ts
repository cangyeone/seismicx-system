import { createContext, useContext } from "react";
export interface AdminSession {
  authenticated: boolean;
  username?: string;
  csrf?: string;
  expires?: number;
}
export const AdminContext = createContext(false);
export const useAdmin = () => useContext(AdminContext);
