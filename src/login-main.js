import "./styles.css";
import { initializeAuth } from "./auth.js";

initializeAuth().catch(console.error);
