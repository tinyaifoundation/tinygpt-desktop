import icon from './assets/dock-icons/tinygpt-ios-default.png?asset';
import windowsIcon from './assets/tinygpt.ico?asset';
export const windowIcon = process.platform === 'win32' ? windowsIcon : icon;
