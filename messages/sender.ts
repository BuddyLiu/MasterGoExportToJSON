// 插件（主线程）发出的消息
export enum PluginMessage {
  EXPORTING = 'exporting',
  EXPORT_PROGRESS = 'export-progress',
  /** 单个画板导出完成（增量交付，UI 边收边渲染卡片） */
  EXPORT_FRAME_READY = 'export-frame-ready',
  EXPORT_RESULT = 'export-result',
  EXPORT_CANCELLED = 'export-cancelled',
  EXPORT_ERROR = 'export-error',
  FRAME_PNG_READY = 'frame-png-ready',
  ALL_PNG_READY = 'all-png-ready',
  PNG_ERROR = 'png-error',
  /** ZIP 打包阶段的高清 PNG 重导出进度（逐画板上报，仅打包时使用） */
  ZIP_PROGRESS = 'zip-progress',
}

// UI 发出的消息
export enum UIMessage {
  READY = 'ready',
  EXPORT_SELECTION = 'export-selection',
  EXPORT_PAGE = 'export-page',
  /** 导出勾选画板（1-based 画板序号数组，映射到最近一次成功导出的画板） */
  EXPORT_FRAME_SUBSET = 'export-frame-subset',
  EXPORT_CANCEL = 'export-cancel',
  EXPORT_FRAME_PNG = 'export-frame-png',
  EXPORT_ALL_PNG = 'export-all-png',
  /** 重新加载插件：主线程取消在途导出并关闭插件，提示开发者重新运行「打开插件」加载最新代码 */
  RELOAD_PLUGIN = 'reload-plugin',
  /** 调整插件窗口尺寸：主线程 clamp 后调用 mg.ui.resize 并持久化到 clientStorage */
  RESIZE_WINDOW = 'resize-window',
}

type MessageType = {
  type: UIMessage | PluginMessage
  data?: any
}

/**
 * 向 UI 发送消息
 */
export const sendMsgToUI = (data: MessageType) => {
  mg.ui.postMessage(data, '*')
}

/**
 * 向插件（主线程）发送消息
 */
export const sendMsgToPlugin = (data: MessageType) => {
  parent.postMessage(data, '*')
}
