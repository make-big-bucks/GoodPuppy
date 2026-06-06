# ADR-0006：ConnectionProfile 抽象为自部署预留接缝

- 状态：已采纳
- 日期：2026-06-05

## 背景

GoodPuppy v1 使用官方托管的 Supabase 后端，`backendUrl` 和 `publishableKey` 当前由构建配置提供。

长期来看，GoodPuppy 有"身份握在自己手里"的产品愿景，对应的技术路径是允许用户自部署后端（自己的 Supabase 实例或兼容后端）。如果现在不做任何抽象，未来支持自部署时需要在代码中全局搜索替换 Supabase 配置，改动面难以控制。

需要在不增加 v1 产品复杂度（不暴露 UI 开关）的前提下，留好架构接缝。

## 决策

将 Supabase 连接配置抽象为一个 **`ConnectionProfile`** 对象：

```typescript
type ConnectionProfile = {
  backendUrl: string;
  publishableKey: string;
};
```

- v1：`ConnectionProfile` 在构建时硬编码指向官方托管后端，行为与现状完全一致。
- 代码中所有初始化 Supabase client 的地方，通过 `ConnectionProfile` 传入，不直接读取裸字符串常量。
- **v1 不暴露任何切换 UI**——用户看不到也无法修改这个配置。
- 架构上允许将来从本地存储、环境变量或用户输入中读取 `ConnectionProfile`，替换为自部署后端。

## 后果

**正面：**
- 自部署支持的变更范围收敛到 `ConnectionProfile` 的来源逻辑，不影响业务代码。
- v1 产品复杂度零增加——用户完全感知不到这层抽象。
- 为 v2 密钥对身份 + 自部署后端的差异化定位打好技术基础（见 ADR-0002）。

**负面：**
- 多一层间接性，新加入的开发者需要理解"配置从哪里来"。
- 若长期不启用自部署，这层抽象可能被视为过度设计（YAGNI 风险）。

**约束：**
- v1 的 `ConnectionProfile` 值通过构建时注入（如环境变量 → 构建产物），不在运行时从用户输入读取。
- 不提前实现"配置切换"逻辑，仅确保 Supabase client 初始化入口统一。
- 该决策与 ADR-0002（Supabase Auth 身份方案）配合：publishable key 通过 `ConnectionProfile` 传入，不允许 service-role/secret key 进入客户端。
