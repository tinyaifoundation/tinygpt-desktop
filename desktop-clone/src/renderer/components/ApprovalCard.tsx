import { Hand } from '../icons';
import type { ComponentProps, ReactNode } from 'react';

export function ApprovalCard({ heading, title, description, actions, descriptionId, icon, ...props }: ComponentProps<'section'> & {
  heading: string;
  title: ReactNode;
  description?: ReactNode;
  actions: ReactNode;
  descriptionId: string;
  icon?:ReactNode;
}) {
  // Inline requests leave the rest of the app usable, including a browser login.
  // A dialog role makes native-view occlusion treat this card as an overlay.
  return <section {...props} role="region" aria-labelledby={props['aria-label'] ? undefined : `${descriptionId}-heading`} aria-describedby={descriptionId} className="permission-grant">
    <div className="permission-grant-heading">{icon??<Hand />}<span id={`${descriptionId}-heading`}>{heading}</span></div>
    <p id={descriptionId} className="permission-grant-question">{title}</p>
    {description}
    <div className="permission-grant-controls">{actions}</div>
  </section>;
}
