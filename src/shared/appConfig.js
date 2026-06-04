const supabase = {
  url: "https://mrvdeeiiwnegaqjwpsgk.supabase.co",
  restUrl: "https://mrvdeeiiwnegaqjwpsgk.supabase.co/rest/v1",
  apiKey: "sb_publishable_bFATe1o6HCfPJwiBripDqg_utJGVUxV",
};

const currentUser = "user_a";

const presence = {
  tableName: "presence",
  userIdColumn: "user_id",
  onlineColumn: "is_online",
  updatedAtColumn: "last_seen",
  heartbeatMs: 30000,
  staleAfterMs: 45000,
};

const userConfigs = {
  user_a: {
    presenceId: 1,
    side: "left",
    tableName: "user_a_message",
    initialState: 6,
  },
  user_b: {
    presenceId: 2,
    side: "right",
    tableName: "user_b_message",
    initialState: 6,
  },
};

module.exports = {
  currentUser,
  presence,
  supabase,
  userConfigs,
};
