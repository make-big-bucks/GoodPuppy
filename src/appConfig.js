// Slice 1：本地体验，不含 supabase 字段（Slice 2 重建数据层时引入）
const currentUser = "user_a";

const userConfigs = {
  user_a: { side: "left", initialState: 6 },
  user_b: { side: "right", initialState: 6 },
};

export default { currentUser, userConfigs };
