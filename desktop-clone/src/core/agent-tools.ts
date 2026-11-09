import { toolDefinitions } from '../shared/tools';
import { isComputerTool } from '../shared/computer';
import { visionTool } from '../shared/vision';
import { simpleWorkToolDefinitions } from '../shared/work';
import { withoutToolMetadata } from './work-tool-catalog';
import type { ChatWorkerInput } from '../shared/chat';

const workOnly = new Set(['list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command', 'create_project_directory', 'edit_project_file', 'review_project_changes', 'run_project_command', 'command_status', 'command_stop', 'copy_skill_files', 'request_plugin_connection']);
export function agentTools(input: Pick<ChatWorkerInput, 'mode' | 'computer' | 'vision' | 'imageTools' | 'workTask'>) {
  const work = input.mode === 'code';
  if (work) return [...toolDefinitions.filter(tool => !['request_plugin_connection', 'present', 'list_project_files', 'read_project_file', 'write_project_file', 'edit_project_file', 'create_project_directory', 'run_project_command'].includes(tool.name) && (!isComputerTool(tool.name) || input.computer === true) && (input.vision || input.imageTools || !visionTool(tool.name))), ...(input.workTask ? simpleWorkToolDefinitions : [])].map(withoutToolMetadata);
  return toolDefinitions.filter(tool => !workOnly.has(tool.name) && (!isComputerTool(tool.name) || input.computer === true) && (input.vision === true || input.imageTools === true || !visionTool(tool.name)));
}
