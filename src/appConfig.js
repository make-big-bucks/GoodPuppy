const currentUser = "user_a";

const supabase = {
  url: "https://mrvdeeiiwnegaqjwpsgk.supabase.co",
  apiKey: "sb_publishable_bFATe1o6HCfPJwiBripDqg_utJGVUxV",
};

const userConfigs = {
  user_a: { side: "left", initialState: 6 },
  user_b: { side: "right", initialState: 6 },
};

export default { currentUser, supabase, userConfigs };
