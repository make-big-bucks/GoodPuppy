const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = "https://mrvdeeiiwnegaqjwpsgk.supabase.co";
const supabaseKey = "sb_publishable_bFATe1o6HCfPJwiBripDqg_utJGVUxV";

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

let received = false;

const channel = supabase
  .channel("good-puppy-realtime-test")
  .on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "test"
    },
    (payload) => {
      received = true;
      console.log("received", JSON.stringify(payload.new));
    }
  )
  .subscribe(async (status) => {
    console.log("status", status);

    if (status === "SUBSCRIBED") {
      const { data, error } = await supabase
        .from("test")
        .insert({
          info: "Realtime test from GoodPuppy",
          state: 6
        })
        .select();

      console.log("insert", JSON.stringify({ data, error }));
    }
  });

setTimeout(async () => {
  await supabase.removeChannel(channel);
  console.log(received ? "result=received" : "result=timeout");
  process.exit(received ? 0 : 1);
}, 15000);
