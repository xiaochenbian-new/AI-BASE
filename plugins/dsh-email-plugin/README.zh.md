# dsh-email-plugin

给 DeepSeek Harness（DSH）加三个「发邮件」工具，默认对接 QQ 邮箱的 SMTP 服务。纯 ESM、零依赖、不需要 nodemailer，离线也能安装。

| 工具 | 作用 |
| --- | --- |
| `email_send` | 发信：纯文本 / HTML / 抄送 / 密送 / 文件附件 |
| `email_verify` | 只连接并登录，不发信，用来排查账号问题 |
| `email_status` | 查看当前生效的配置（密码打码）与配置文件路径 |

模型永远拿不到你的密码：账号信息只从本机配置文件 / 环境变量 / 插件行 `config` 读取，工具的调用参数里没有密码字段。

## 1. 生成 QQ 邮箱授权码

QQ 邮箱**不能用登录密码**发信，必须用「授权码」：

1. 浏览器登录 <https://mail.qq.com>。
2. 打开 **设置 → 账号**（旧版：设置 → 账户）。
3. 找到 **POP3/IMAP/SMTP 服务**，开启 **IMAP/SMTP 服务**。
4. 按提示验证密保后生成 **授权码**（16 位左右，只显示一次，复制保存）。

服务器参数固定为：

```
smtp.qq.com:465  (SSL/TLS，secure: "tls")
```

## 2. 写入凭据

创建 `%USERPROFILE%\.dsh\email-plugin.json`（即 `C:\Users\<你>\.dsh\email-plugin.json`）：

```json
{
  "smtp": {
    "host": "smtp.qq.com",
    "port": 465,
    "secure": "tls",
    "user": "你的QQ邮箱@qq.com",
    "pass": "第 1 步生成的授权码"
  },
  "defaultTo": "你的QQ邮箱@qq.com",
  "timeoutMs": 15000
}
```

`from` 默认等于 `smtp.user`；要显示发件人名字可以加：

```json
"from": { "name": "我的 DSH", "address": "你的QQ邮箱@qq.com" }
```

也可以用环境变量（优先级高于 JSON 文件）：

| 变量 | 含义 |
| --- | --- |
| `DSH_EMAIL_USER` / `DSH_EMAIL_PASS` | 账号 / 授权码 |
| `DSH_EMAIL_HOST` / `DSH_EMAIL_PORT` / `DSH_EMAIL_SECURE` | 服务器与加密方式（`tls` / `starttls` / `plain`） |
| `DSH_EMAIL_FROM` / `DSH_EMAIL_TO` | 默认发件人 / 默认收件人 |

配置文件在**每次调用时读取**，改完不需要重启 DSH。

> 安全提示：`email-plugin.json` 里是明文授权码，请只放在本机并限制访问；泄露后到 QQ 邮箱重新生成即可作废。

## 3. 安装

本插件在 [AI-BASE](https://github.com/xiaochenbian-new/AI-BASE) 仓库的 `plugins/dsh-email-plugin` 下。

方式一，直接安装 GitHub Release 里的 tgz（桌面端用应用自带的 dsh 命令）：

```sh
dsh plugin --profile desktop add https://github.com/xiaochenbian-new/AI-BASE/releases/download/dsh-email-plugin-v0.1.2/dsh-email-plugin-0.1.2.tgz
```

也可以从界面安装：**插件 → 添加插件 → 安装第三方插件**，填这个 URL 或本地 tgz 的绝对路径。

方式二，克隆仓库后从本地目录安装（改代码时用这个）：

```sh
git clone https://github.com/xiaochenbian-new/AI-BASE.git
dsh plugin --profile desktop add ./AI-BASE/plugins/dsh-email-plugin
```

方式三，自己构建：

```sh
npm pack            # 生成 dsh-email-plugin-0.1.2.tgz
dsh plugin --profile desktop add ./dsh-email-plugin-0.1.2.tgz
```

安装后如果工具还没出现，卸载再装一次或**完全退出并重新打开 DeepSeek Harness**（宿主会缓存已加载的模块）。

卸载：

```sh
dsh plugin --profile desktop remove dsh-email-plugin
```

## 4. 使用

### 图形化设置页（推荐）

插件在 DSH 自己的 Web 服务上挂了一个设置页，打开：

```text
http://127.0.0.1:1461/dsh-email-plugin/settings
```

端口换成你实际的 DSH Web 端口（运行中可用 `email_status` 工具查到完整地址）。页面里可以填邮箱地址、SMTP 授权码、服务器、端口、加密方式、发件人、默认收件人，点「保存配置」立即生效；还有「测试连接」和「发送测试邮件」两个按钮。授权码不会回显，留空表示保持原值。

页面也可以直接在系统浏览器里打开（只监听 127.0.0.1，写操作要求同源请求）。

### 对话里调用工具

- 「用 email_verify 检查邮箱配置」
- 「给我的 QQ 邮箱发一封测试邮件，主题『DSH 测试』」
- 「把这份报告作为附件发到 xxx@qq.com」

## 开发

```sh
node --test test/plugin.test.mjs
```

测试自带一个本地 mock SMTP 服务器，覆盖 AUTH LOGIN、DATA、多收件人、中文主题编码、附件、535 授权码错误提示，以及设置页的保存 / 越权拦截 / 测试发信等场景，不需要真实账号。

目录：

```
lib/config.js   配置解析（文件 / 环境变量 / 插件行 config，密码打码，原子写回）
lib/mime.js     RFC 5322 + MIME 构建（RFC 2047 主题、RFC 2231 附件名、base64、点填充）
lib/smtp.js     SMTP 客户端（隐式 TLS / STARTTLS / 明文，AUTH LOGIN、AUTH PLAIN）
lib/settings.js 设置页 HTML 与 /dsh-email-plugin/api/* 路由处理
lib/index.js    Cordis 插件入口、三个工具定义、Web 路由注册
cordis.patch.yml  安装到 profile 后插入的插件行
```

兼容性：`engines.dsh` 声明为 `^0.2.2-rc.1 || ^0.2.1`，已在 DSH 0.2.2-rc.1 上按插件接口验证。

## 实现说明

- 工具定义直接使用 DSH 注册表要求的 `{ name, description, parameters(JSON Schema), output, execute }` 结构，不 import `@deepseek-ai/dsh-tools`，因此插件本身没有任何 npm 依赖，安装时不会触发构建脚本授权。
- 设置页通过 `ctx.webServer.register` 注册在宿主 Web 服务上；没有 Web 服务的 profile（headless / SDK）会自动跳过，只保留工具。
- 设置页安全策略：只接受回环 Host，写操作要求同源 Origin（跨站表单会被 403），授权码永不回显。
- SMTP 会话遵循协作式取消：工具执行收到 `exec.signal` 时断开连接。
- 收件人全部被拒绝、认证失败、连接超时等都会转换成模型可见的 `Error`，其中 535 会附带「QQ 邮箱要用授权码而不是登录密码」的提示。
