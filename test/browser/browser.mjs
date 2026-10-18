import {chromium,firefox,webkit} from 'playwright';

export const browserName=process.env.UI_TEST_BROWSER??'chromium';
const engine={chromium,firefox,webkit}[browserName];
if(!engine)throw Error('UI_TEST_BROWSER must be chromium, firefox or webkit');
export function launchBrowser(){
  return engine.launch({headless:true,...(browserName==='chromium'&&process.env.SOLID_CHROMIUM_PATH?{executablePath:process.env.SOLID_CHROMIUM_PATH}:{})});
}
