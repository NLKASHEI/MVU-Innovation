# 角色有自己的生活 - 基于 generate 的多角色卡实践

协议：MIT

## 引言
在之前的可攻略角色卡实践中，为确保各个角色能在合适的场景中自然登场，我们常采用蓝色灯的世界书条目进行辅助，类似于青空莉在《[三个女孩各有秘密](https://gitgud.io/StageDog/tavern_resource/-/blob/main/%E8%A7%92%E8%89%B2%E5%8D%A1/%E4%B8%89%E4%B8%AA%E5%A5%B3%E5%AD%A9%E5%90%84%E6%9C%89%E7%A7%98%E5%AF%86/%E6%BA%90%E6%96%87%E4%BB%B6/%E4%B8%96%E7%95%8C%E4%B9%A6/%E8%A7%92%E8%89%B2%E5%88%97%E8%A1%A8.yaml)》中的应用，在世界书中加入形如下面yaml 的内容：
```aiignore
慕心:
      名字: 莲见慕心
      name: Moko
      full name: Renmi Moko
      info: 18岁，美术系学生兼修计算机课程。原本活泼开朗的性格因姐姐悠纪的神秘消失而变得沉稳内敛。
      current state: 日常穿搭和言行举止不经意间模仿姐姐的风格。
      出场: 姐妹曾共同居住的宿舍房间(现仅她一人居住)、艺术教室、图书馆计算机区、悠纪常去的图书馆角落、校园后山(据说是姐姐最后出现的地方)、深夜的空教室(她偷偷使用学校设备继续项目开发的地方)。尤其在与姐姐有关的地点或物品附近时，会表现出明显的情绪波动。
rule:
  - 在剧情中合适时候按照`出场`或与出场类似情况自然地引入`角色列表`中的角色
  - 不在`角色列表`列表的其他角色都仅仅是烘托氛围的路人，与主要角色不存在亲密关系
  - 一次只能引入一位角色

```
这个条目会专门放在 D4+ 深度，用于提醒 llm 在故事中存在着这个人物，可以合适的场合进行人物的引入。作为辅助，在角色卡的 CoT 里面可能会有文本说明关于是否应当引入人物的判定。 然而，这种做法虽然能让角色保持连续性，却使得角色的行动始终与用户密切挂钩，给人一种“所有角色只为用户存在”的印象。

为了避免这个缺点，可以考虑将重要人物的行动，作为 COT/结果输出格式 的一部分，要求在每一次对话中都输出。但这又会导致输出格式过为复杂，要求输出十个甚至九个指定的 xml/json 块。这种做法会比较考验 llm 对于输出格式的依从性，也更可能因为预设/模型等原因，在输出中缺失部分格式片段。而且，每一个额外的格式片段，也可能会导致其他片段文本的详细程度降低，最终使得 {user} 体验到的整体效果不佳。

也许有人会说“你要体验这样的多人卡，那么直接使用酒馆的聊天室就可以啦”。实际上如果你体验过将一些使用了酒馆助手/提示词模板的角色卡，导入到聊天室，那么你会发现在导入时世界书立刻开始报错，或者部分脚本功能无法正常运行，也因此并没法做到比较好的效果。

因此，在角色卡 [Moonlit Remnant](https://discord.com/channels/1291925535324110879/1355209319548977333) 中，我尝试通过 generate 的方式实现了一套对应于多角色的行动系统。在这套行动系统中，每一个角色都会在 {user} 进行行动时，单独使用一个 generate 请求，进行 CoT ，最终表现为 对话、行为、和决策。

本文主要介绍了系统的设计思路、具体实现流程以及开发中遇到的问题，并对各个部分的技术细节进行了解析。通过这个系统，你可以做到“在{user}行动时，角色在背后进行着她自己的冒险”之类的效果，两者互不冲突。此外也可以借助 "提示词模板语法" 等手段，更加精细的判断各个角色知道的信息，避免秘密泄露。

总体而言，如果你期望自己的角色卡，也做到：
- 构建多角色分支剧情，如“校园生活模拟器”
- 所有角色都有“线下活动”的场景构建
- 角色信息不同步的剧情（例如隐瞒/欺骗）
- 高沉浸式的角色扮演系统设计

可以考虑参考这张角色卡的做法。
接下来的部分主要会对两个方面进行描述：
- 整体模块的运行流程
- 开发过程中遇到的问题

## 核心流程
以下的内容都是基于 [Moonlit Remnant 源代码](https://discord.com/channels/1291925535324110879/1355209319548977333) 中的片段进行描述的，可以参照完整源码进行查看。

消息生成整体流程大致为：
```
用户发送消息
      ↓
触发 GENERATION_STARTED 事件
      ↓
角色判断是否执行（时段、位置、指令合法性等）
      ↓
准备角色的历史记录 + 日程
      ↓
执行 generate → 角色行动
      ↓
更新变量、插入 <CharView>
      ↓
继续执行用户消息对应的主流程
```
下面为一个示例场景:
```
{user}在周一下午发送消息：“我们去人工湖看看吗？”

判断角色 暮莲 当前与 {user} 在相同位置，应该进行行动。

拼装生成请求，包含 暮莲 当前日程、用户最后行为和她自己的历史行动。
调用 generate 得到角色响应内容，里面包含 <CharView> 形式的第三视角的完整描述。

更新变量，将 暮莲 的当前时间和状态变化存储到角色专属变量内。

最后生成用户信息，在用户信息的生成过程中，包含 暮莲 <CharView> 的内容，保证行为的一致性。
```

### 角色机制
在开始详细的说明之前，我先简单介绍一下 Moonlit 中角色行动的机制。后续代码也是通过这个机制，来决定一个角色是否应当行动。
#### 行动条件
在这张角色卡中，使用了 "时间段" 机制，其他角色只有在时间段变更时，或者与 {user} 在同一个位置时，会进行行动。前者是为了角色能自主行动；后者是为了对话时如果要透露秘密，可以由 {char} 的视角输出，也为了 {char} 的行动能更加符合逻辑。

对于更加普遍的 24小时制场景，也可以考虑在 {char} 的输出中增加 "消耗时间"，当 <user> 的行动到达对应的时间点后，再进行行动，如：
0. {char} 和 {user} 的当前时间都为 12 点
1. {char} 行动，消耗 60分钟，{char} 当前时间变为 13 点
2. {user} 行动，消耗 15 分钟，{user} 当前时间变为 12 点 15
3. {user} 行动，消耗 60 分钟，{user} 当前时间变为 13 点 15
4. {char} 再次行动。

#### 日程机制
对于 {char}，实际上并不是给它一个宽泛的指令，让她按照宽泛的指令自由行动。在这张卡中，为每个角色构造了一个 "日程" 系统。在这个系统中，对应每一个时间段都预先给 {char} 安排了一个需要完成的目标，如：
```json5
{
  "日程": {
    "周一": {
      "上午": [
        "前往地点:central_control_tower.接入仓室 行为:迎接刚苏醒的user",
        "上午的计划"
      ],
      "下午": [
        "前往地点:eco_garden.人工湖与空气净化花园 行为:检查",
        "下午的计划"
      ],
      "晚上": [
        "前往地点:central_control_tower.接入仓室 行为:迎接刚苏醒的透花",
        "晚上的计划"
      ]
    },
    "周二": {
      "上午": [
        "前往地点:data_center_zone.数据服务器室 行为:检查",
        "上午的计划"
      ],
      "下午": [
        "前往地点:data_center_zone.记忆碎片库 行为:检查",
        "下午的计划"
      ],
      "晚上": [
        "前往地点:eco_garden.人工湖与空气净化花园 行为:娱乐，散步",
        "晚上的计划"
      ]
    },//后略
  }
}
```
这些日程在变量初始化时会赋一个初始值，使角色在主线结束之前的行动是稳定、基本可控的，不过因为日程是变量的一部分，实际上也会存在角色按需更新自己日程的情况，如约好了跟 {user} 一同约会之类的。

#### 行动机制
在 generate 过程中，对于 {char} 的指令，与平时 {user} 的指令，类似，处于最后一条 user 消息的内容中，采用的形式为：
```
我是暮莲;我目前的行为是:<current_schedule>${currentSchedule}</current_schedule> 此时<user>的行为是:<user_action>${charContent}</user_action>
```
里面包含：
- 对自身的身份认知
- 角色自己的日程安排 `current_schedule`
- {user} 的行为。即最后一次 {user} 发出的文本。为了能对 {user} 接下来的行动做出响应

#### 提供的信息
在 generate 过程中，为了保证 {char} 的行为是连贯，有记忆的，也会携带 summary/CharView 等必要信息。具体包含：
- 当前角色 过去所有的 CharView。注意只是角色自己的，不同角色的，和 {user} 的 summary 都是分开的，不会包含在内。
- 最近一次其他 {char}/{user} 的 CharView。提供的理由是为了能够对其他角色的最近行动进行响应。

最终一次 {char} 的请求中，内容会是下面的形式：
```json5
[
    {
      role: 'assistant',
      content: '\n' +
        '周一，上午，central_control_tower.user个人房间。暮莲正准备离开，手已伸向门禁。希雅指着角落发出嗡鸣的白色空气净 化器，请求暮莲修复它。暮莲停下脚步，转身回到房间中央的操作终端前。她保持着平静的表情，向希雅演示了如何通过终端呼叫维修机器人。她一边操作一边解释：“这个终端…可以处理…你看…选择‘设备维护申请’…确认故障设备…” 确认请求发送成功后，她告知 希雅机器人会很快抵达，并再次强调自己需要离开去处理其他维护任务。随后，她转身，毫不迟疑地离开了房间，门在她身后关闭。整个过程中，她身着银白色潜入服，抱着头盔，动作干练，语气保持着礼貌的距离感，手腕上的蓝色发带偶尔随着动作摆动。\n'
    },
    {
      role: 'assistant',
      content: '<CharView希雅>\n' +
        '周一，上午，中央控制塔控制室。希雅在房间内拔掉了老旧空气净化器的插头，随后维修机器人前来将其更换为新的设备。希 雅决定去控制室看看，沿着走廊找到了控制室的门。透过观察窗，他看到暮莲正在巨大的环形控制台前专注地工作。希雅请求进入，门打开后，他看到了控制室内布满屏幕和数据的景象。暮莲转过身，平静地询问希雅有何事，态度略显疏离。\n' +
        '</CharView希雅>'
    },
    { role: 'system', content: '<the_previous_round_of_interaction>' },
    {
      role: 'assistant',
      content: '\n' +
        '周一，上午，central_control_tower.接入仓室。希雅向暮莲提出想要四处看看的请求。暮莲同意后，两人离开了接入仓室。 房间内，只剩下透花所在的接入仓仍在安静运作。仓内，透花身着银白色潜入服，保持着沉睡的状态，面无表情，对外界发生的一切毫无反应。她的意识似乎完全沉浸在虚拟世界的连接中，身体仅有维生系统带来的微弱起伏。显示面板上的数据流稳定滚动，一切生理指标正常。\n'
    },
    {
      role: 'user',
      content: '<inputs>\n' +
        '我是暮莲;我目前的行为是:<current_schedule>已完成：迎接刚苏醒的user</current_schedule> 此时希雅的行为是:<user_action>还是前往 人工湖与空气净化花园 吧</user_action>\n' +
        '</inputs>'
    },
]
```
其中包含了 {char} 自己的历史行动以及 {user} 的最近行动。

#### 行动机制
在对应的 generate 请求中，最后一条 user 消息包含的即为 {char} 的行动
### 触发角色行动
虽然上面一直在期望达到 "没有{user}世界也在照常运行" 的目的，但是实际上在这个角色卡的实践中，是以 {user} 发送一条消息作为触发条件的：
```typescript
eventOn(tavern_events.GENERATION_STARTED, executeCharSchedule);
```
`GENERATION_STARTED` 是一个事件，当 {user} 发送消息时被触发。触发后会调用 `executeCharSchedule`
函数，待调度完成后，才会继续处理消息发布的后续流程。在这个函数中，我们就可以执行角色的行动逻辑。

### 执行条件判断
不过有很多原因都会导致这个事件被触发，我们需要一一对其进行判断，如下面的代码：
```typescript
export async function executeCharSchedule(_type: string, _option: any, dry_run: boolean) {
    if (isProcessing)
        return;//正在处理generate，不重复触发
    if (dry_run)
        return;//不是真实的触发
    const lastMessage = await getLastMessageId();
    var last_chat_msg_list = await getChatMessages(lastMessage);

    //var variable = getLastValidVariable(last_message);
    var charContent = last_chat_msg_list[0].message;
    var lastUserMessage = lastMessage;
    var lastUserMessageContent = last_chat_msg_list[0];

    for (; ;) {
        if (lastUserMessageContent.role != "user") {
            --lastUserMessage;
            if (lastUserMessage < 0) {
                console.log("no user message");
                return;//在0楼层场景下发送空消息
            }
            var prevMessage = await getChatMessages(lastUserMessage);
            lastUserMessageContent = prevMessage[0];
            continue;
        }
        charContent = lastUserMessageContent.message;
        console.log(`Get last user content: ${charContent}`);
        await insertOrAssignVariables({当前行为: charContent}, {type: "global"});
        break;
    }
    if (last_chat_msg_list[0].role != 'user') {
        console.log("not user message");
        return;//最后一条消息不是user发送的
    }
    const variables = await getLastValidVariable(lastMessage - 1);
    if (!_.has(variables, "stat_data")) {
        console.error("cannot found stat_data.");
        return; //变量无效，后续逻辑会出错
    }
    if (last_chat_msg_list[0].message.startsWith("/"))
        return;//当前语句是 slash
    /*后略*/
}
```
上面这段代码检查的情况主要有：
- 在 `generate` 过程中递归调用此方法
- 只是试运行`dry_run`。这一般发生在切换聊天记录/角色卡时。
- 上一层的发送者不是 `user`，这说明用户并没有决定下一步行动，只是误触。（如果你理解这是让角色继续自己动，这也ok）
- 在空聊天列表中发送空消息。注意发送空消息并不会产生新的 user 楼层。
- 变量未正确初始化，一般不会发生。
- 当前语句是 slash 语句，如 `/delete 3`

在这几种情况下，都不应该触发角色的行为，否则就真的是 "角色会自己动"了。

### 整理角色消息历史
这段逻辑主要是从所有历史消息中，取出所有与特定角色相关的记录，保证对应角色的行为是连贯的，且只知道她应该知道的信息。

为了使角色的行动能够明确的描述，实际上我也通过CoT指定了所需的输出格式，对于角色而言是：
```ejs
<Format>
输出格式强调:
  rule:
    - The following must be inserted to the end of each reply, and cannot be omitted
    - You must insert <UpdateVariable> tag,update the variables refer to <Analysis> rule, Ignore CharView related content when evaluate.
    - check whether `设施信息.{{get_message_variable::stat_data.user.地点.0}}.malfunction` should be updated
    - check whether `{{get_global_variable::当前角色}}.着装` should be updated
    - <CharView></CharView>(中间填写时间和地点, 如 周一，中午，central_control_tower.接入仓室)(填写从在场的第三者视角，如实记录 {{get_global_variable::当前角色}} 的行为、想法是怎样的。信息包含 {{get_global_variable::当前角色}}、相关人员 的行动、对话，地点。不需要进行性格的评判和说明）
  format: |-
    <CharView>
    ...
    </CharView>
    <UpdateVariable>
    <Analysis>
    ...
    </Analysis>
    ...
    </UpdateVariable>
</Format>
```
除了正常的变量更新相关字段外，使用 `<CharView>` 代替了通常的 Summary 段，以第三方视角，对角色的行为进行描述。在后续的执行流程中，也会对应这个 xml 元素进行检查，作为角色后续所需的 Summary 和其他角色行动的参照。
```typescript
    const allMessage = await getChatMessages("0-{{lastMessageId}}");

    /**
     * 从 allMessage 产生 kurenView, toukaView, userView, 三个集合，条件分别是：
     * name 为 暮莲， name 为 透华， message 中包含 <summary></summary> 块。
     * 集合内的元素需要转换为 RolePrompt，即 {role: 'assistant', content: message}
     * message内容需要进行裁剪。前两个集合是保留 `/<CharView[^>]*>(.*?)<\/CharView[^>]*>/s 匹配到的所有部分；
     * 后一个则是取<summary></summary> 块内的所有部分。
     */
    const kurenView: RolePrompt[] = [];
    const toukaView: RolePrompt[] = [];
    const userView: RolePrompt[] = [];

    allMessage.forEach(msg => {
        if (msg.name === "暮莲") {
            const matches = [...msg.message.matchAll(/<CharView[^>]*>(.*?)<\/CharView[^>]*>/gs)];
            matches.forEach(match => kurenView.push({role: 'assistant', content: match[1]}));
        } else if (msg.name === "透花") {
            const matches = [...msg.message.matchAll(/<CharView[^>]*>(.*?)<\/CharView[^>]*>/gs)];
            matches.forEach(match => toukaView.push({role: 'assistant', content: match[1]}));
        } else if (/<summary>.*?<\/summary>/s.test(msg.message)) {
            const match = msg.message.match(/<summary>(.*?)<\/summary>/s);
            if (match) {
                userView.push({role: 'assistant', content: `<CharView{{user}}>${match[1]}</CharView{{user}}>`});
            }
        }
    });
    const statData : GameData = variables.stat_data;
```
在这段代码中，会在之前的聊天记录中，搜寻 `<CharView暮莲>` `<CharView透花>` `<summary>` 等片段，分别对应角色，和{user} 自己的历史。在之后的流程中，会分开给予llm。

### 进度提示
毕竟整个应答生成要花费一分钟，还是加个进度提示吧？

```typescript
    /**
 * Represents the total count of characters.
 * It is initialized to 0 and can be used to track or accumulate the number of characters processed.
 */
var totalChar = 0;
/**
 * Asynchronous listener function that processes incremental text input.
 * Updates the total character count based on the length of the provided text.
 *
 * @param {string} incremental_text - The incremental string input to process.
 * If this string is not empty or undefined, its length is added to the total character count.
 */
var listener = async (incremental_text: string) => {
    if (incremental_text) {
        totalChar += incremental_text.length;
    }
};
eventOn(iframe_events.STREAM_TOKEN_RECEIVED_INCREMENTALLY, listener);
try {
    /**
     * Executes a given callback function at specified intervals (in milliseconds).
     * The interval continues to execute until explicitly stopped.
     *
     * @param {Function} callback - The function to execute at each interval.
     * @param {number} delay - The duration of the interval in milliseconds.
     * @returns {Object} An object containing a `start` method to begin the interval and a `stop` method to clear it.
     */
    interval = setInterval(async () => {
        await setChatMessage({message: "世界正在转动...总生成字符数：" + totalChar + "," + Math.random()}, nowLastMessage, {refresh: "display_current"});
    }, 1000);
    /**
     * Indicates whether a task, process, or action has been completed.
     *
     * @type {boolean}
     */
    isFinished = false;
    //具体生成的代码
    /**
     * Represents the status of whether a specific process, task, or operation is completed.
     *
     * @type {boolean}
     */
    isFinished = true;
    clearInterval(interval);
} finally {
    if (!isFinished)
        clearInterval(interval);
    eventRemoveListener(iframe_events.STREAM_TOKEN_RECEIVED_INCREMENTALLY, listener);
}
```
上面的代码首先注册了 `STREAM_TOKEN_RECEIVED_INCREMENTALLY` 事件，每当 `generate` 过程流式收到新的 token 时，就会修改局部变量 `totalChar`，将其增加新收到的数值。配合 `setInterval` 中的回调，就可以更新某一层消息的内容了，给用户一种脚本在运行，并没有在摸鱼的感觉。

### 通过 generate 产生角色行动
在完成了上面的准备后，终于可以开始进行角色行动的生成了。
```typescript
    for (;;){
        //检查角色是否应该行动
        if (statData.暮莲.时段[0] === statData.user.时段[0] && statData.暮莲.地点[0] !== statData.user.地点[0])
        {
            console.log("not in same time and same place");
            break;
        }
        await triggerSlash(`/hide ${lastMessage}`);
        //根据日程生成角色的行动
        // @ts-ignore
        var currentSchedule : string = _.get(statData.暮莲.日程, `${statData.日期[0]}.${statData.user.时段[0]}[0]`);
        if (currentSchedule === undefined || currentSchedule === '空')
            currentSchedule = "进行合适的，符合暮莲性格的行为。";
        var requestContent = `我是暮莲;我目前的行为是:<current_schedule>${currentSchedule}</current_schedule> 此时<user>的行为是:<user_action>${charContent}</user_action>`;
        //产生角色行动对应的消息楼层
        await triggerSlash(`/sendas name="暮莲" "世界开始转动..."`);
        const nowLastMessage = await getLastMessageId();
        await triggerSlash(`/hide ${nowLastMessage}`);
        await insertOrAssignVariables({当前角色: "暮莲"}, {type: "global"});
        await new Promise(resolve => setTimeout(resolve, 1500));
        interval = setInterval(async () => {
            await setChatMessage({message: "世界正在转动...总生成字符数：" + totalChar + "," + Math.random()}, nowLastMessage, {refresh: "display_current"});
        }, 1000);
        var fillContent: string;
        isFinished = false;
        //调整世界书绿灯激活
        var kurenInjects: InjectionPrompt[] = [{
            position: "none", depth: 999, should_scan: true, role: "assistant",
            content: "角色-暮莲"
        }];
        // 拼接 kurenView、userView 和 toukaView 的最后一项内容
        // 拼接出角色可以掌握的历史
        const combinedContent = [
            ...kurenView,
            userView.length > 0 ? userView[userView.length - 1] : null,
            toukaView.length > 0 ? toukaView[toukaView.length - 1] : null
        ].filter(item => item !== null);
        for (;;) {
            totalChar = 0;
            //循环发送消息，直到成功为止。
            var result = await generate({
                user_input: requestContent,
                overrides: {chat_history: {prompts: combinedContent}},
                injects: kurenInjects,
                should_stream: true
            });
            console.log(result);
            // Extract content inside the <CharView></CharView> block and other content
            const charViewMatch = result.match(/<CharView[^>]*>(.*?)<\/CharView[^>]*>/s);
            const otherContent = charViewMatch ? result.replace(charViewMatch[0], "").trim() : result; // Everything else excluding <CharView>

            if (!charViewMatch) {
                await new Promise(resolve => setTimeout(resolve, 1500));
                continue;//如果没有找到CharView，说明生成不是成功的，重试
            }
            fillContent = `<FullContent>${otherContent}</FullContent><CharView暮莲>${charViewMatch ? charViewMatch[1] : ""}</CharView暮莲>`;
            if (charViewMatch) {
                kurenView.push({role: 'assistant', content: charViewMatch[0]});
            }
            break;
        }

        clearInterval(interval);
        isFinished = true;
        //更新楼层内容
        await setChatMessage({message: fillContent}, nowLastMessage, {refresh: 'display_and_render_current'});
        //更新暮莲的变量
        await handleResponseMessage();
        await triggerSlash(`/unhide ${nowLastMessage}`);
        break;
    }
```
这是最复杂的部分。这段代码按顺序做了下面的事情：
- 检查角色是否符合行动条件
- 根据日程拼接角色行动的文本
- 通过 slash 指令创建角色行动的楼层
- 拼接出角色掌握的历史消息
- 发送 generate 请求
- 从结果中抽出行动的 summary 和完整的内容，结束生成过程。
- 更新楼层内容

这一系列过程是异步执行的，完成一个角色的 generate 操作后，结果会更新到对应的楼层上。

### 回到 {user} 行动的主消息生成
在 `GENERATION_STARTED` 的回调函数结束后，就会继续原本 {user} 的消息回复生成。在这个回复中，也会包含之前其他角色行动后的 Summary，以对那些角色的行动做出响应。


### 总结
上面主要说明了 Moonlit Remnant 的核心游戏机制，以及为了驱动这些机制而编写的相关代码逻辑角色行动通过“日程表”与“时间段”系统驱动，仅在与玩家处于相同时间/地点或时间段变更时触发，确保角色行为具备逻辑一致性。行为生成由事件 `GENERATION_STARTED` 驱动，判断条件包括用户是否发出有效消息、消息是否为用户输入等。系统会整理历史消息（按 <CharView>、<summary> 标签）并传入 LLM。行为生成过程异步进行，提供实时进度提示以提升体验。角色生成完毕后再处理用户输入，最终达到"角色有自己生活"的目的。

## 遇到的问题
在这整个流程的开发中，我也需要了许多细节方面的问题，这里也一并进行分享。

### 预设的人称指定会与 generate 逻辑冲突
在一部分预设的人称指定开关下，会使用形如 `Use "你" instead of "{{user}}" in the narration.` 的表述，强制指定了当前的角色为 {user}。这会导致上面 `我是暮莲;` 的自我认知失效。为了解决这个问题，需要把内容中的 `{{user}}` 替换成 `{{get_global_variable::当前角色}}` 等在 generate 过程中导出的当前角色的信息。

### 与预设的精简文本功能的冲突
在部分预设中会将 10 层以上的非 summary 文本过滤。但是上面的逻辑已经进行过一次 summary 了，实际上不需要这个功能，反而会导致有效信息被过滤，因此需要关闭

### 与 {{user}} 使用不同的cot
{{char}} 的 CoT 因为输入内容等原因，需要对哪些内容是自己的行动，是否要与 {user} 的行动互相影响等专有内容进行强调。为了避免将一个 CoT 写的过于复杂，分成了两个文件，也方面更细节的调控。

### 变量更新的隔离
因为整个角色卡的变量列表对所有 {char} 和 {user} 都是可见的，有时会导致 {char} 对 {user} 的状态进行变更。为了避免，我通过 <self_description> 块描述了每个角色自己的变量范围，在变量检查相关的规则内，只强调这个块，而不是完整的变量列表，以避免 llm 过于主动的更新所有变量。虽然有时还是会更新它认为相关的变量...

此外，如日程等私密的内容，是仅当对应角色的 generate 操作中才会出现的，在其他角色的生成过程中不会出现，自然也不会被修改了。

### 角色行为、视角的一致性
每个角色的动作是先后生成的，但是实际上从{user}视角，她们应当是同时进行行动的。那么如何保证这种一致性呢？在这张角色卡中给出的答案是：在 CoT 里检查最近的 <CharView>。要求新生成的内容，如果是相同位置，相关的，那么要符合之前的 <CharView>。

如：
- 角色 暮莲 对 {user} 的抚摸产生了害羞的应答。这记录在了最近的 <CharView暮莲> 中。
- 角色 透花 的行动中，看到了上面 <CharView> 中，暮莲产生害羞，并依此在这个展开中加入自己的行动，记录在 <CharView透花> 中。
- {user} 的应答生成过程，会读取上面的内容，并以此作为基准，即后续的展开，是包含 暮莲 和 透花 的行动，经过润色产生的。

通过在 CoT 中强调这种连贯性，最终使得不同角色的视角，依然是连贯、大体一致的。

## 展望
这张角色的开发过程中，我尝试了更加有自主性的角色行动机制，最终也取得了相对不错的效果，也欢迎大家来玩~。在之后的角色卡制作中，我也会进一步探索这方面的实践，尝试将这部分逻辑通用化，可以单独作为一个脚本存在，以便更多人使用。
