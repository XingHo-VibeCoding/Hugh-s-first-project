// Day 15｜/api/health 健康检查云函数（学分规划助手 · credit-planner）
// 作用：证明「代码能部署到 CloudBase 并被公网访问」这条链路是通的。
// 它不连数据库、不做任何业务——今天只当"后端的心跳灯"。
// Day 16 之后的业务接口（板块/课程 CRUD）会写在同一个函数里，按路径分发。

exports.main = async function () {
  return {
    ok: true,
    service: "credit-planner",
    time: new Date().toISOString(), // 服务器当前时间，用来确认这是云端实时返回的
  };
};
