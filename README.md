# testWork_skill

资源中心页面测试与 TAPD 缺陷创建 skill：`resource-test-tapd`。

## 功能

- 按业务端、页面、缺陷和回测批次归档测试材料。
- 从固定 TAPD 登录入口检查会话；未登录时由用户自行登录，已登录时跳过手动登录。
- 根据本次提供的项目名称选择项目，在同一个带窗口的 Chrome 中完成创建。
- 从缺陷正文读取优先级、严重程度，自动上传正文引用的非图片文件。
- 发现版本、模块、处理人交由用户后续手动补填。
- 提交后核对缺陷详情，并保存回执、截图和内容指纹，防止重复创建。

## 环境与安装

当前版本面向 Windows，默认测试工作目录为 `D:\资源中心测试`，需要 Node.js 20+、npm、Python 和本机 Chrome。

在新环境中，将仓库克隆到约定的 skill 路径：

```powershell
git clone git@github.com:bunk-cpu/testWork_skill.git 'D:\资源中心测试\.agents\skills\resource-test-tapd'
Set-Location 'D:\资源中心测试\.agents\skills\resource-test-tapd'
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

已有该目录时先保留本地材料，不直接覆盖。脚本通过 skill 的安装位置定位工作根目录，因此应保留 `.agents\skills\resource-test-tapd` 这层目录结构。开始执行前读取工作根目录的 `AGENTS.md`；结果存放约定见 [SKILL.md](SKILL.md) 与 [归档规则](references/result-layout.md)。

## 使用

向代理提供本次项目名称，以及需要创建的已审核缺陷。仅需验证链路时，明确要求创建一条自动化验证记录。

代理执行以下命令；`login` 持续运行，后续命令在另一个终端连接同一个浏览器宿主：

```powershell
node scripts/tapd.mjs login
node scripts/tapd.mjs project --project-name '本次项目名称'
node scripts/tapd.mjs inspect --form
node scripts/tapd.mjs validate --manifest '已审核清单的绝对路径.json'
node scripts/tapd.mjs submit --manifest '已审核清单的绝对路径.json'
node scripts/tapd.mjs close
```

若进入手动登录分支，由用户在浏览器完成登录并告知代理“已登录”，代理再使用 `confirm-login` 通知原进程核对。具体清单格式、登录告知与中断恢复见 [TAPD 操作说明](references/tapd-workflow.md)。

TAPD 防护或服务异常可能阻止创建。结果不确定时先核实已有记录，不直接重复提交。

## 验证与目录

```powershell
npm test
```

本地测试使用模拟页面，不向真实 TAPD 创建缺陷；输出按新的回测批次保存。当前流程已通过 27 项本地测试，并完成一次真实创建、正文分级、JSON 附件上传、图片排除、详情核对与重复提交保护验证。

- `SKILL.md`：skill 入口与执行约定。
- `agents/`：skill 界面元数据。
- `scripts/`：登录、浏览器会话、缺陷创建、材料校验与本地测试脚本。
- `references/`：操作说明、归档规则与未批准的清单示例。
- `config.json`：固定登录入口与页面选择器；其他项目的表单可能需要适配。

`.local/` 中的登录状态、浏览器资料与会话文件，以及 `node_modules/`、Python 缓存和本地环境文件不纳入版本控制。运行后产生的业务缺陷材料与测试结果保留在本地工作目录。
