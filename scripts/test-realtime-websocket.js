const supabaseUrl = "mrvdeeiiwnegaqjwpsgk.supabase.co";
const supabaseKey = "sb_publishable_bFATe1o6HCfPJwiBripDqg_utJGVUxV";

const socket = new WebSocket(`wss://${supabaseUrl}/realtime/v1/websocket?apikey=${supabaseKey}&vsn=1.0.0`);
let ref = 1;

function send(topic, event, payload = {}) {
  socket.send(JSON.stringify(["1", String(ref++), topic, event, payload]));
}

socket.addEventListener("open", () => {
  console.log("open");
  send("realtime:good-puppy-test", "phx_join", {
    config: {
      broadcast: { self: false },
      presence: { key: "" },
      postgres_changes: [
        {
          event: "INSERT",
          schema: "public",
          table: "test"
        }
      ]
    },
    access_token: supabaseKey
  });

  setInterval(() => {
    send("phoenix", "heartbeat");
  }, 25000);
});

socket.addEventListener("message", (event) => {
  console.log("message", event.data);
});

socket.addEventListener("error", (event) => {
  console.log("error", event.message || event.type);
});

socket.addEventListener("close", (event) => {
  console.log("close", event.code, event.reason);
});

setTimeout(() => {
  socket.close();
  process.exit(0);
}, 60000);
