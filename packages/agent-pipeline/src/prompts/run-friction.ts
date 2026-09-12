import { REPORT_RUN_FRICTION_TOOL_NAME } from "../tools/run-friction-tool.js";

export const RUN_FRICTION_SYSTEM_HINT = `Run friction: if you encounter meaningful inefficiency (tool failures you worked around, wrong approach, missing docs/context, excessive retries), call ${REPORT_RUN_FRICTION_TOOL_NAME} with a short factual summary before you finish. Do not call it when the run was straightforward. The runner appends these notes (and automatic tool errors) to the phase summary.`;
