export const connectorSplashNames = { gmail: 'Gmail', gdrive: 'Google Drive', gcalendar: 'Google Calendar', notion: 'Notion', github: 'GitHub', slack: 'Slack', higgsfield: 'Higgsfield', linear: 'Linear' } as const;
export type ConnectorSplash = keyof typeof connectorSplashNames;
export const connectorSplashIds = Object.keys(connectorSplashNames) as ConnectorSplash[];
