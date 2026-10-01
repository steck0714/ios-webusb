// page.ts — entry injected into the page's own JS world (MAIN) by the content script.
import { installNavigatorUsb } from '../core/install.ts';
import { createRelayPicker } from '../core/pick.ts';
import { PostMessageTransport } from '../core/transports/postmessage.ts';

const transport = new PostMessageTransport(window);
installNavigatorUsb({
  runtime: { transport, requestDevice: createRelayPicker(transport) },
  variant: 'crx',
});
