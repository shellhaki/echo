// Import this first in every script so env vars exist before lib/env.ts runs.
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
