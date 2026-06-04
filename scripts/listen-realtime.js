const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = "https://mrvdeeiiwnegaqjwpsgk.supabase.co";
const supabaseKey = "sb_publishable_bFATe1o6HCfPJwiBripDqg_utJGVUxV";

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const channel = supabase
  .channel("good-puppy-listen-test")
  .on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "test"
    },
    (payload) => {
      console.log("received", JSON.stringify(payload.new));
    }
  )
  .subscribe((status) => {
    console.log("status", status);
  });

setTimeout(async () => {
  await supabase.removeChannel(channel);
  console.log("done");
  process.exit(0);
}, 60000);
