import { AgentScheduler } from "./packages/coding-agent/src/task/schedule/scheduler.ts";

const scheduler = new AgentScheduler();

scheduler.createSchedule({
  id: "test-1",
  name: "test",
  cronPattern: "* * * * * *", // every second
  prompt: "Say hello",
  workspaceRoot: process.cwd(),
});

console.log("Active schedules:", scheduler.getSchedules().length);
scheduler.pauseSchedule("test-1");
console.log("Paused schedule");
scheduler.resumeSchedule("test-1");
console.log("Resumed schedule");

console.log("Test completed successfully!");
process.exit(0);
