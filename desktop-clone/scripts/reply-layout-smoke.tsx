import { createRoot } from 'react-dom/client';
import { useContext, useState } from 'react';
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from '@assistant-ui/react';
import { AssistantMessage, UserMessage, ConversationActions } from '../src/renderer/components/ConversationMessages';
import { TooltipProvider } from '../src/renderer/components/ui/tooltip';
import { useMessages } from '../src/renderer/lib/conversation-messages';
import { remoteView } from '../src/shared/remote';
import type { ChatUpdate } from '../src/shared/chat';
import { applyMobileAppearance } from '../src/renderer/lib/mobile-appearance';
applyMobileAppearance({theme:'dark',variables:{'--user-ui-font':'"Figtree Variable",system-ui','--user-content-font':'"Figtree Variable",system-ui','--user-ui-weight':'400','--user-content-weight':'400','--user-ui-size':'14px','--user-ui-scale':'1'}},'dark');

const initial:ChatUpdate={conversation:{id:'chat',projectId:null,title:'Reply layout',mode:'chat',createdAt:0,updatedAt:0,messages:[],tools:[],sources:[]},library:{projects:[],conversations:[],lastConversationId:'chat',activeRuns:[],approvals:[],browserHandoffs:[]}};
function Fixture(){
  const [update,setUpdate]=useState(initial),[mobile,setMobile]=useState(false);
  (window as any).replyFixture={show:(value:ChatUpdate,phone=false)=>{setMobile(phone);setUpdate(phone?remoteView(value):value);}};
  const messages=useMessages(update.conversation,update.library.activeRuns[0]);
  const defaults=useContext(ConversationActions);
  const runtime=useExternalStoreRuntime({messages,convertMessage:message=>message,isRunning:!!update.library.activeRuns.length,onNew:async()=>{}});
  return <TooltipProvider><AssistantRuntimeProvider runtime={runtime}><ConversationActions.Provider value={defaults}><ThreadPrimitive.Root className={'conversation-pane '+(mobile?'mobile-thread':'')} data-mode={update.conversation.mode}><ThreadPrimitive.Viewport className="thread-viewport"><div className="thread-message-column"><ThreadPrimitive.Messages components={{AssistantMessage,UserMessage}} /></div></ThreadPrimitive.Viewport></ThreadPrimitive.Root></ConversationActions.Provider></AssistantRuntimeProvider></TooltipProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
