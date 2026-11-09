import { forwardRef } from 'react';
import { Button, type ButtonProps } from './button';
import { cn } from '../../lib/utils';

type SettingsButtonProps = Omit<ButtonProps, 'variant' | 'size'> & {
  variant?: 'pill' | 'destructive' | 'ghost' | 'muted';
  size?: 'action' | 'icon';
};

/** The same compact pill used by Configuration's Add action. */
export const SettingsButton = forwardRef<HTMLButtonElement, SettingsButtonProps>(({ variant = 'pill', size = 'action', className, ...props }, ref) => (
  <Button ref={ref} variant={variant === 'muted' ? 'ghost' : variant} size={size} className={cn(size === 'icon' ? 'settings-icon-button' : 'settings-action-button', variant === 'muted' && 'settings-muted-action', className)} {...props} />
));
SettingsButton.displayName = 'SettingsButton';
