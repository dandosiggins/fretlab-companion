import { createClient } from "@supabase/supabase-js";

/* Same nullable-client pattern as FretLab: without env vars the app
   still runs, local-only. */
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && key ? createClient(url, key) : null;
