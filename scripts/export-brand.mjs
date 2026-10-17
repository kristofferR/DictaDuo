#!/usr/bin/env node
// Reproducible PNG, ICNS, and pixel-proof exports from the checked Inkflow vectors.
// Dependency: sharp 0.35.4. No font installation or native macOS tools are needed.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, mkdtemp, readdir, stat, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(root, 'Resources/Brand');
const sharpVersion = '0.35.4';
const installCommand = `npm install --prefix .build/brand-tools --no-save --no-package-lock sharp@${sharpVersion}`;
const marker = 'dictaduo-inkflow-brand-export-v1\n';
const pngOptions = { compressionLevel: 9, adaptiveFiltering: false, palette: false };
const appSizes = [16, 22, 24, 32, 48, 64, 128, 256, 512, 1024];
const symbolSizes = [16, 18, 22, 24, 32, 36, 44, 48, 64];
const proofSizes = [16, 18, 22, 24, 32];
const iconset = [
  { name: 'icon_16x16.png', size: 16, type: 'icp4', points: 16, scale: 1 },
  { name: 'icon_16x16@2x.png', size: 32, type: 'ic11', points: 16, scale: 2 },
  { name: 'icon_32x32.png', size: 32, type: 'icp5', points: 32, scale: 1 },
  { name: 'icon_32x32@2x.png', size: 64, type: 'ic12', points: 32, scale: 2 },
  { name: 'icon_128x128.png', size: 128, type: 'ic07', points: 128, scale: 1 },
  { name: 'icon_128x128@2x.png', size: 256, type: 'ic13', points: 128, scale: 2 },
  { name: 'icon_256x256.png', size: 256, type: 'ic08', points: 256, scale: 1 },
  { name: 'icon_256x256@2x.png', size: 512, type: 'ic14', points: 256, scale: 2 },
  { name: 'icon_512x512.png', size: 512, type: 'ic09', points: 512, scale: 1 },
  { name: 'icon_512x512@2x.png', size: 1024, type: 'ic10', points: 512, scale: 2 },
];

// Proof-label outlines from Noto Sans Bold 2.015, the same OFL-licensed font as
// the wordmark. Keeping these small glyph outlines here makes the proof independent
// of font substitution. Copyright 2022 The Noto Project Authors; see
// Resources/Brand/FONT-LICENSE.txt for the complete SIL Open Font License 1.1.
const proofGlyphs = {" ":{"advance":260,"d":""},"A":{"advance":692,"d":"M527 0 472 -168H220L165 0H0L251 -717H439L692 0ZM387 -451C384.33 -461 380.17 -476 374.5 -496C368.83 -516 363.33 -536.5 358 -557.5C352.67 -578.5 348.33 -595.67 345 -609C342.33 -593.67 338.5 -576.17 333.5 -556.5C328.5 -536.83 323.67 -517.5 319 -498.5C314.33 -479.5 310.33 -463.67 307 -451L256 -296H437Z"},"B":{"advance":665,"d":"M316 -714C414 -714 485.33 -699.5 530 -670.5C574.67 -641.5 597 -596.67 597 -536C597 -491.33 585.17 -455.83 561.5 -429.5C537.83 -403.17 509.33 -386.33 476 -379V-374C499.33 -369.33 521.67 -361 543 -349C564.33 -337 581.67 -319.67 595 -297C608.33 -274.33 615 -244.33 615 -207C615 -141.67 591.5 -90.83 544.5 -54.5C497.5 -18.17 433.33 0 352 0H85V-714ZM324 -428C367.33 -428 397.5 -436 414.5 -452C431.5 -468 440 -489 440 -515C440 -542.33 430 -562.5 410 -575.5C390 -588.5 359 -595 317 -595H238V-428ZM238 -313V-121H335C380.33 -121 411.83 -130.17 429.5 -148.5C447.17 -166.83 456 -190.33 456 -219C456 -245 447 -267.17 429 -285.5C411 -303.83 378 -313 330 -313Z"},"C":{"advance":642,"d":"M398 -597C340.67 -597 295.5 -575.5 262.5 -532.5C229.5 -489.5 213 -430.33 213 -355C213 -279.67 228.83 -221.17 260.5 -179.5C292.17 -137.83 340 -117 404 -117C435.33 -117 465.5 -120.67 494.5 -128C523.5 -135.33 552.67 -144.67 582 -156V-26C525.33 -2 460.33 10 387 10C311 10 248.5 -5.17 199.5 -35.5C150.5 -65.83 114.17 -108.5 90.5 -163.5C66.83 -218.5 55 -282.67 55 -356C55 -428 68.33 -491.67 95 -547C121.67 -602.33 160.67 -645.67 212 -677C263.33 -708.33 326 -724 400 -724C435.33 -724 471.17 -720.17 507.5 -712.5C543.83 -704.83 578.33 -693 611 -677L561 -555C537 -566.33 511.5 -576.17 484.5 -584.5C457.5 -592.83 428.67 -597 398 -597Z"},"D":{"advance":732,"d":"M678 -369C678 -287 662.67 -218.67 632 -164C601.33 -109.33 558 -68.33 502 -41C446 -13.67 379.67 0 303 0H85V-714H321C433 -714 520.5 -684.5 583.5 -625.5C646.5 -566.5 678 -481 678 -369ZM518 -363C518 -439.67 501 -496.5 467 -533.5C433 -570.5 383 -589 317 -589H238V-126H302C446 -126 518 -205 518 -363Z"},"E":{"advance":560,"d":"M501 0H90V-714H501V-590H241V-433H483V-309H241V-125H501Z"},"F":{"advance":549,"d":"M239 0H90V-714H499V-590H239V-406H481V-282H239Z"},"G":{"advance":724,"d":"M361 -401H644V-31C606.67 -18.33 567.83 -8.33 527.5 -1C487.17 6.33 441.33 10 390 10C283.33 10 201.33 -21.33 144 -84C86.67 -146.67 58 -238 58 -358C58 -432.67 72.5 -497.33 101.5 -552C130.5 -606.67 172.67 -649 228 -679C283.33 -709 351 -724 431 -724C469 -724 506.33 -720 543 -712C579.67 -704 613 -693.33 643 -680L593 -559C571 -570.33 546 -579.67 518 -587C490 -594.33 460.67 -598 430 -598C386 -598 347.83 -588 315.5 -568C283.17 -548 258.17 -519.83 240.5 -483.5C222.83 -447.17 214 -404.33 214 -355C214 -308.33 220.33 -267 233 -231C245.67 -195 265.67 -166.83 293 -146.5C320.33 -126.17 356 -116 400 -116C421.33 -116 439.5 -117 454.5 -119C469.5 -121 483.33 -123.33 496 -126V-275H361Z"},"H":{"advance":765,"d":"M675 0H524V-308H241V0H90V-714H241V-434H524V-714H675Z"},"I":{"advance":389,"d":"M357 0H32V-86L119 -126V-588L32 -628V-714H357V-628L270 -588V-126L357 -86Z"},"J":{"advance":331,"d":"M15 210C-4.33 210 -21.33 208.83 -36 206.5C-50.67 204.17 -63.33 201.67 -74 199V73C-63.33 75.67 -52.17 78 -40.5 80C-28.83 82 -16.33 83 -3 83C14.33 83 30.17 79.67 44.5 73C58.83 66.33 70 53.67 78 35C86 16.33 90 -10.33 90 -45V-714H241V-46C241 15.33 231.5 64.83 212.5 102.5C193.5 140.17 167 167.5 133 184.5C99 201.5 59.67 210 15 210Z"},"K":{"advance":664,"d":"M664 0H492L305 -301L241 -255V0H90V-714H241V-387C261 -415 281 -443 301 -471L494 -714H662L413 -398Z"},"L":{"advance":559,"d":"M85 0V-714H238V-126H527V0Z"},"M":{"advance":943,"d":"M392 0 220 -560H216C216.67 -546.67 217.67 -526.67 219 -500C220.33 -473.33 221.67 -444.83 223 -414.5C224.33 -384.17 225 -356.67 225 -332V0H90V-714H296L465 -168H468L647 -714H853V0H712V-338C712 -360.67 712.5 -386.67 713.5 -416C714.5 -445.33 715.5 -473.17 716.5 -499.5C717.5 -525.83 718.33 -545.67 719 -559H715L531 0Z"},"N":{"advance":813,"d":"M723 0H531L220 -540H216C217.33 -506 218.83 -472 220.5 -438C222.17 -404 223.67 -370 225 -336V0H90V-714H281L591 -179H594C593.33 -212.33 592.33 -245.33 591 -278C589.67 -310.67 588.33 -343.33 587 -376V-714H723Z"},"O":{"advance":791,"d":"M735 -358C735 -284 722.83 -219.5 698.5 -164.5C674.17 -109.5 637 -66.67 587 -36C537 -5.33 473 10 395 10C317.67 10 253.83 -5.33 203.5 -36C153.17 -66.67 115.83 -109.67 91.5 -165C67.17 -220.33 55 -285 55 -359C55 -432.33 67.17 -496.5 91.5 -551.5C115.83 -606.5 153.17 -649.17 203.5 -679.5C253.83 -709.83 318 -725 396 -725C473.33 -725 537.17 -709.83 587.5 -679.5C637.83 -649.17 675 -606.5 699 -551.5C723 -496.5 735 -432 735 -358ZM216 -358C216 -283.33 230.17 -224.83 258.5 -182.5C286.83 -140.17 332.33 -119 395 -119C459 -119 504.83 -140.17 532.5 -182.5C560.17 -224.83 574 -283.33 574 -358C574 -432.67 560.17 -491.33 532.5 -534C504.83 -576.67 459.33 -598 396 -598C332.67 -598 286.83 -576.67 258.5 -534C230.17 -491.33 216 -432.67 216 -358Z"},"P":{"advance":621,"d":"M309 -714C401 -714 469 -694.83 513 -656.5C557 -618.17 579 -564 579 -494C579 -452 570.33 -412.67 553 -376C535.67 -339.33 506.83 -309.67 466.5 -287C426.17 -264.33 371.67 -253 303 -253H238V0H85V-714ZM304 -589H238V-379H289C331 -379 364.17 -387.33 388.5 -404C412.83 -420.67 425 -449 425 -489C425 -521 415.17 -545.67 395.5 -563C375.83 -580.33 345.33 -589 304 -589Z"},"Q":{"advance":791,"d":"M735 -358C735 -278.67 720.83 -209.67 692.5 -151C664.17 -92.33 620 -49.33 560 -22L733 170H536L409 10C407 10 404.67 10 402 10C399.33 10 397 10 395 10C317.67 10 253.83 -5.33 203.5 -36C153.17 -66.67 115.83 -109.67 91.5 -165C67.17 -220.33 55 -285 55 -359C55 -432.33 67.17 -496.5 91.5 -551.5C115.83 -606.5 153.17 -649.17 203.5 -679.5C253.83 -709.83 318 -725 396 -725C473.33 -725 537.17 -709.83 587.5 -679.5C637.83 -649.17 675 -606.5 699 -551.5C723 -496.5 735 -432 735 -358ZM216 -358C216 -283.33 230.17 -224.83 258.5 -182.5C286.83 -140.17 332.33 -119 395 -119C459 -119 504.83 -140.17 532.5 -182.5C560.17 -224.83 574 -283.33 574 -358C574 -432.67 560.17 -491.33 532.5 -534C504.83 -576.67 459.33 -598 396 -598C332.67 -598 286.83 -576.67 258.5 -534C230.17 -491.33 216 -432.67 216 -358Z"},"R":{"advance":656,"d":"M304 -714C490 -714 583 -644.67 583 -506C583 -457.33 570.67 -417.67 546 -387C521.33 -356.33 490.67 -332.33 454 -315L657 0H482L323 -274H238V0H85V-714ZM301 -595H238V-392H301C341.67 -392 373 -400.33 395 -417C417 -433.67 428 -461 428 -499C428 -531 417.83 -555 397.5 -571C377.17 -587 345 -595 301 -595Z"},"S":{"advance":551,"d":"M511 -198C511 -134.67 488.17 -84.17 442.5 -46.5C396.83 -8.83 332 10 248 10C172.67 10 105.33 -4.33 46 -33V-174C80 -159.33 115.17 -145.83 151.5 -133.5C187.83 -121.17 224 -115 260 -115C297.33 -115 323.83 -122.17 339.5 -136.5C355.17 -150.83 363 -169 363 -191C363 -209 356.83 -224.33 344.5 -237C332.17 -249.67 315.67 -261.5 295 -272.5C274.33 -283.5 250.67 -295.33 224 -308C207.33 -316 189.33 -325.5 170 -336.5C150.67 -347.5 132.17 -361.17 114.5 -377.5C96.83 -393.83 82.33 -413.67 71 -437C59.67 -460.33 54 -488.33 54 -521C54 -585 75.67 -634.83 119 -670.5C162.33 -706.17 221.33 -724 296 -724C333.33 -724 368.83 -719.67 402.5 -711C436.17 -702.33 471.33 -690 508 -674L459 -556C426.33 -569.33 397 -579.67 371 -587C345 -594.33 318.33 -598 291 -598C262.33 -598 240.33 -591.33 225 -578C209.67 -564.67 202 -547.33 202 -526C202 -500.67 213.33 -480.67 236 -466C258.67 -451.33 292.33 -433.33 337 -412C373.67 -394.67 404.83 -376.67 430.5 -358C456.17 -339.33 476 -317.33 490 -292C504 -266.67 511 -235.33 511 -198Z"},"T":{"advance":577,"d":"M365 0H212V-587H19V-714H558V-587H365Z"},"U":{"advance":756,"d":"M671 -252C671 -202.67 660.17 -158.17 638.5 -118.5C616.83 -78.83 584.17 -47.5 540.5 -24.5C496.83 -1.5 441.67 10 375 10C280.33 10 208.33 -14.17 159 -62.5C109.67 -110.83 85 -174.67 85 -254V-714H236V-277C236 -218.33 248 -177 272 -153C296 -129 331.67 -117 379 -117C428.33 -117 464.17 -130 486.5 -156C508.83 -182 520 -222.67 520 -278V-714H671Z"},"V":{"advance":650,"d":"M650 -714 407 0H242L0 -714H153L287 -289C289.67 -281.67 293.5 -268.17 298.5 -248.5C303.5 -228.83 308.67 -208.17 314 -186.5C319.33 -164.83 323 -146.67 325 -132C327 -146.67 330.5 -164.83 335.5 -186.5C340.5 -208.17 345.67 -228.83 351 -248.5C356.33 -268.17 360 -281.67 362 -289L497 -714Z"},"W":{"advance":967,"d":"M967 -714 785 0H613L516 -375C514 -382.33 511.5 -393.33 508.5 -408C505.5 -422.67 502.17 -438.67 498.5 -456C494.83 -473.33 491.67 -489.83 489 -505.5C486.33 -521.17 484.33 -533.33 483 -542C482.33 -533.33 480.5 -521.17 477.5 -505.5C474.5 -489.83 471.33 -473.5 468 -456.5C464.67 -439.5 461.33 -423.5 458 -408.5C454.67 -393.5 452 -382 450 -374L354 0H182L0 -714H149L240 -324C244 -308.67 248.33 -289.33 253 -266C257.67 -242.67 262 -219.33 266 -196C270 -172.67 273 -153 275 -137C277 -153.67 280 -173.5 284 -196.5C288 -219.5 292.17 -241.83 296.5 -263.5C300.83 -285.17 304.67 -302 308 -314L412 -714H555L659 -314C662.33 -302.67 666.17 -286 670.5 -264C674.83 -242 679 -219.33 683 -196C687 -172.67 690 -153 692 -137C694 -153.67 697 -173.5 701 -196.5C705 -219.5 709.5 -242.67 714.5 -266C719.5 -289.33 723.67 -308.67 727 -324L818 -714Z"},"X":{"advance":670,"d":"M666 0H490L332 -257L173 0H3L240 -368L17 -714H187L334 -470L478 -714H649L425 -359Z"},"Y":{"advance":626,"d":"M313 -415 460 -714H626L390 -278V0H236V-273L0 -714H166Z"},"Z":{"advance":579,"d":"M555 0H24V-98L366 -589H33V-714H546V-616L204 -125H555Z"},"0":{"advance":572,"d":"M535 -357C535 -280.33 526.83 -214.67 510.5 -160C494.17 -105.33 467.83 -63.33 431.5 -34C395.17 -4.67 346.33 10 285 10C199 10 136 -22.5 96 -87.5C56 -152.5 36 -242.33 36 -357C36 -434.33 44 -500.33 60 -555C76 -609.67 102.33 -651.67 139 -681C175.67 -710.33 224.33 -725 285 -725C370.33 -725 433.33 -692.67 474 -628C514.67 -563.33 535 -473 535 -357ZM186 -357C186 -275.67 193 -214.5 207 -173.5C221 -132.5 247 -112 285 -112C322.33 -112 348.33 -132.33 363 -173C377.67 -213.67 385 -275 385 -357C385 -438.33 377.67 -499.67 363 -541C348.33 -582.33 322.33 -603 285 -603C247 -603 221 -582.33 207 -541C193 -499.67 186 -438.33 186 -357Z"},"1":{"advance":572,"d":"M413 0H262V-413C262 -430.33 262.5 -453 263.5 -481C264.5 -509 265.33 -533.67 266 -555C262.67 -551 255.5 -543.83 244.5 -533.5C233.5 -523.17 223.33 -514 214 -506L132 -440L59 -531L289 -714H413Z"},"2":{"advance":572,"d":"M539 0H40V-105L219 -286C255 -323.33 284 -354.5 306 -379.5C328 -404.5 344 -427.17 354 -447.5C364 -467.83 369 -489.67 369 -513C369 -541.67 361.17 -563 345.5 -577C329.83 -591 308.67 -598 282 -598C254.67 -598 228 -591.67 202 -579C176 -566.33 148.67 -548.33 120 -525L38 -622C58.67 -640 80.5 -656.67 103.5 -672C126.5 -687.33 153.17 -699.83 183.5 -709.5C213.83 -719.17 250.33 -724 293 -724C339.67 -724 379.83 -715.5 413.5 -698.5C447.17 -681.5 473.17 -658.5 491.5 -629.5C509.83 -600.5 519 -567.67 519 -531C519 -491.67 511.17 -455.67 495.5 -423C479.83 -390.33 457.17 -358 427.5 -326C397.83 -294 362 -258.67 320 -220L228 -134V-127H539Z"},"3":{"advance":572,"d":"M511 -554C511 -504.67 496.17 -465.33 466.5 -436C436.83 -406.67 400.33 -386.67 357 -376V-373C414.33 -366.33 457.83 -349 487.5 -321C517.17 -293 532 -255.33 532 -208C532 -166.67 521.83 -129.5 501.5 -96.5C481.17 -63.5 449.83 -37.5 407.5 -18.5C365.17 0.5 310.67 10 244 10C166.67 10 98 -3 38 -29V-157C68.67 -141.67 100.83 -130 134.5 -122C168.17 -114 199.33 -110 228 -110C282 -110 319.83 -119.33 341.5 -138C363.17 -156.67 374 -183 374 -217C374 -237 369 -253.83 359 -267.5C349 -281.17 331.5 -291.5 306.5 -298.5C281.5 -305.5 246.67 -309 202 -309H148V-425H203C247 -425 280.5 -429.17 303.5 -437.5C326.5 -445.83 342.17 -457.17 350.5 -471.5C358.83 -485.83 363 -502.33 363 -521C363 -546.33 355.17 -566.17 339.5 -580.5C323.83 -594.83 297.67 -602 261 -602C227 -602 197.5 -596.17 172.5 -584.5C147.5 -572.83 126.33 -561.33 109 -550L39 -654C67 -674 99.83 -690.67 137.5 -704C175.17 -717.33 220 -724 272 -724C345.33 -724 403.5 -709.17 446.5 -679.5C489.5 -649.83 511 -608 511 -554Z"},"4":{"advance":572,"d":"M555 -148H469V0H322V-148H17V-253L330 -714H469V-265H555ZM322 -386C322 -401.33 322.33 -420 323 -442C323.67 -464 324.5 -484.5 325.5 -503.5C326.5 -522.5 327.33 -535 328 -541H324C318 -527.67 311.67 -514.67 305 -502C298.33 -489.33 290.33 -476.33 281 -463L150 -265H322Z"},"5":{"advance":572,"d":"M300 -456C343.33 -456 382 -447.67 416 -431C450 -414.33 476.83 -390 496.5 -358C516.17 -326 526 -286.33 526 -239C526 -161.67 502 -100.83 454 -56.5C406 -12.17 335 10 241 10C203.67 10 168.5 6.67 135.5 0C102.5 -6.67 73.67 -16.33 49 -29V-159C73.67 -146.33 103.33 -135.5 138 -126.5C172.67 -117.5 205.33 -113 236 -113C280.67 -113 314.83 -122.17 338.5 -140.5C362.17 -158.83 374 -187.33 374 -226C374 -298 326.33 -334 231 -334C212.33 -334 193 -332.17 173 -328.5C153 -324.83 136.33 -321.33 123 -318L63 -350L90 -714H477V-586H222L209 -446C220.33 -448 232.5 -450.17 245.5 -452.5C258.5 -454.83 276.67 -456 300 -456Z"},"6":{"advance":572,"d":"M35 -303C35 -344.33 38 -385 44 -425C50 -465 60.5 -502.83 75.5 -538.5C90.5 -574.17 111.5 -605.83 138.5 -633.5C165.5 -661.17 199.83 -682.83 241.5 -698.5C283.17 -714.17 333.67 -722 393 -722C407 -722 423.33 -721.5 442 -720.5C460.67 -719.5 476.33 -717.67 489 -715V-594C476.33 -597.33 462.5 -599.83 447.5 -601.5C432.5 -603.17 417.67 -604 403 -604C343.67 -604 297.83 -594.67 265.5 -576C233.17 -557.33 210.33 -531.17 197 -497.5C183.67 -463.83 176 -425 174 -381H180C193.33 -404.33 212.5 -424 237.5 -440C262.5 -456 295 -464 335 -464C397.67 -464 447.33 -444.33 484 -405C520.67 -365.67 539 -310 539 -238C539 -160.67 517.17 -100 473.5 -56C429.83 -12 370.67 10 296 10C247.33 10 203.33 -1.17 164 -23.5C124.67 -45.83 93.33 -80.17 70 -126.5C46.67 -172.83 35 -231.67 35 -303ZM293 -111C322.33 -111 346.33 -121.17 365 -141.5C383.67 -161.83 393 -193.33 393 -236C393 -270.67 385 -298 369 -318C353 -338 328.67 -348 296 -348C274 -348 254.67 -343.17 238 -333.5C221.33 -323.83 208.33 -311.33 199 -296C189.67 -280.67 185 -265 185 -249C185 -227 189 -205.5 197 -184.5C205 -163.5 217.17 -146 233.5 -132C249.83 -118 269.67 -111 293 -111Z"},"7":{"advance":572,"d":"M111 0 379 -587H27V-714H539V-619L269 0Z"},"8":{"advance":572,"d":"M286 -723C327.33 -723 365.17 -716.67 399.5 -704C433.83 -691.33 461.5 -672.33 482.5 -647C503.5 -621.67 514 -589.67 514 -551C514 -508.33 501.83 -473.17 477.5 -445.5C453.17 -417.83 422.67 -395 386 -377C411.33 -363.67 435.5 -348.17 458.5 -330.5C481.5 -312.83 500.17 -292.17 514.5 -268.5C528.83 -244.83 536 -217 536 -185C536 -145.67 525.5 -111.33 504.5 -82C483.5 -52.67 454.17 -30 416.5 -14C378.83 2 335.33 10 286 10C206 10 144.17 -7 100.5 -41C56.83 -75 35 -121.67 35 -181C35 -230.33 48.33 -270 75 -300C101.67 -330 134 -354.33 172 -373C140 -393 112.83 -417.17 90.5 -445.5C68.17 -473.83 57 -509.33 57 -552C57 -590 67.67 -621.67 89 -647C110.33 -672.33 138.5 -691.33 173.5 -704C208.5 -716.67 246 -723 286 -723ZM285 -613C260.33 -613 239.83 -606.67 223.5 -594C207.17 -581.33 199 -563.33 199 -540C199 -515.33 207.67 -495.33 225 -480C242.33 -464.67 262.67 -451.33 286 -440C308.67 -450.67 328.67 -463.5 346 -478.5C363.33 -493.5 372 -514 372 -540C372 -563.33 363.83 -581.33 347.5 -594C331.17 -606.67 310.33 -613 285 -613ZM175 -190C175 -164 184.17 -142.67 202.5 -126C220.83 -109.33 248 -101 284 -101C321.33 -101 349.33 -109 368 -125C386.67 -141 396 -162.33 396 -189C396 -207 390.67 -222.83 380 -236.5C369.33 -250.17 356.17 -262.5 340.5 -273.5C324.83 -284.5 308.67 -294.67 292 -304L279 -311C248.33 -296.33 223.33 -279.33 204 -260C184.67 -240.67 175 -217.33 175 -190Z"},"9":{"advance":572,"d":"M536 -409C536 -368.33 533 -327.83 527 -287.5C521 -247.17 510.5 -209.17 495.5 -173.5C480.5 -137.83 459.5 -106.17 432.5 -78.5C405.5 -50.83 371.17 -29.17 329.5 -13.5C287.83 2.17 237.33 10 178 10C164 10 147.67 9.5 129 8.5C110.33 7.5 94.67 5.67 82 3V-118C95.33 -115.33 109.33 -113 124 -111C138.67 -109 153.33 -108 168 -108C227.33 -108 273.17 -117.5 305.5 -136.5C337.83 -155.5 360.67 -181.67 374 -215C387.33 -248.33 395 -287 397 -331H391C377 -307.67 358.5 -288 335.5 -272C312.5 -256 278.33 -248 233 -248C172.33 -248 123.67 -267.67 87 -307C50.33 -346.33 32 -402 32 -474C32 -551.33 53.83 -612 97.5 -656C141.17 -700 200.33 -722 275 -722C323.67 -722 367.67 -710.83 407 -688.5C446.33 -666.17 477.67 -631.83 501 -585.5C524.33 -539.17 536 -480.33 536 -409ZM278 -601C248.67 -601 224.67 -591 206 -571C187.33 -551 178 -519.33 178 -476C178 -441.33 186 -414 202 -394C218 -374 242.33 -364 275 -364C297.67 -364 317.17 -369 333.5 -379C349.83 -389 362.67 -401.5 372 -416.5C381.33 -431.5 386 -447 386 -463C386 -485 382 -506.67 374 -528C366 -549.33 354 -566.83 338 -580.5C322 -594.17 302 -601 278 -601Z"},"/":{"advance":415,"d":"M410 -720 144 6H7L273 -720Z"},"%":{"advance":902,"d":"M198 -724C251.33 -724 293.33 -704.5 324 -665.5C354.67 -626.5 370 -571.67 370 -501C370 -430.33 355.67 -375.17 327 -335.5C298.33 -295.83 255.33 -276 198 -276C146 -276 105 -295.83 75 -335.5C45 -375.17 30 -430.33 30 -501C30 -571.67 44.17 -626.5 72.5 -665.5C100.83 -704.5 142.67 -724 198 -724ZM707 -714 311 0H192L588 -714ZM199 -627C181 -627 168 -616 160 -594C152 -572 148 -540.67 148 -500C148 -459.33 152 -427.83 160 -405.5C168 -383.17 181 -372 199 -372C217.67 -372 231.17 -383 239.5 -405C247.83 -427 252 -458.67 252 -500C252 -540.67 247.83 -572 239.5 -594C231.17 -616 217.67 -627 199 -627ZM700 -439C752.67 -439 794.5 -419.5 825.5 -380.5C856.5 -341.5 872 -286.67 872 -216C872 -145.33 857.5 -90.17 828.5 -50.5C799.5 -10.83 756.67 9 700 9C648 9 607 -10.83 577 -50.5C547 -90.17 532 -145.33 532 -216C532 -286.67 546.17 -341.5 574.5 -380.5C602.83 -419.5 644.67 -439 700 -439ZM701 -342C682.33 -342 669.17 -331 661.5 -309C653.83 -287 650 -255.67 650 -215C650 -174.33 653.83 -142.83 661.5 -120.5C669.17 -98.17 682.33 -87 701 -87C719.67 -87 733.17 -98 741.5 -120C749.83 -142 754 -173.67 754 -215C754 -256.33 749.83 -287.83 741.5 -309.5C733.17 -331.17 719.67 -342 701 -342Z"},"+":{"advance":572,"d":"M339 -406H528V-299H339V-111H232V-299H43V-406H232V-596H339Z"},".":{"advance":281,"d":"M54 -70C54 -100.67 62.5 -122.33 79.5 -135C96.5 -147.67 117 -154 141 -154C164.33 -154 184.5 -147.67 201.5 -135C218.5 -122.33 227 -100.67 227 -70C227 -40.67 218.5 -19.5 201.5 -6.5C184.5 6.5 164.33 13 141 13C117 13 96.5 6.5 79.5 -6.5C62.5 -19.5 54 -40.67 54 -70Z"},"#":{"advance":646,"d":"M488 -412 465 -299H591V-198H446L408 0H301L339 -198H244L207 0H102L138 -198H22V-299H157L180 -412H57V-514H198L236 -713H343L305 -514H402L440 -713H545L507 -514H624V-412ZM263 -299H359L382 -412H286Z"},"=":{"advance":572,"d":"M43 -394V-500H528V-394ZM43 -204V-311H528V-204Z"},":":{"advance":281,"d":"M54 -473C54 -503.67 62.5 -525.17 79.5 -537.5C96.5 -549.83 117 -556 141 -556C164.33 -556 184.5 -549.83 201.5 -537.5C218.5 -525.17 227 -503.67 227 -473C227 -443 218.5 -421.5 201.5 -408.5C184.5 -395.5 164.33 -389 141 -389C117 -389 96.5 -395.5 79.5 -408.5C62.5 -421.5 54 -443 54 -473ZM54 -70C54 -100.67 62.5 -122.33 79.5 -135C96.5 -147.67 117 -154 141 -154C164.33 -154 184.5 -147.67 201.5 -135C218.5 -122.33 227 -100.67 227 -70C227 -40.67 218.5 -19.5 201.5 -6.5C184.5 6.5 164.33 13 141 13C117 13 96.5 6.5 79.5 -6.5C62.5 -19.5 54 -40.67 54 -70Z"},"(":{"advance":339,"d":"M40 -274C40 -355.33 51.83 -433.83 75.5 -509.5C99.17 -585.17 136.33 -653.33 187 -714H309C263.67 -651.33 229.17 -582.33 205.5 -507C181.83 -431.67 170 -354.33 170 -275C170 -197.67 181.83 -121.5 205.5 -46.5C229.17 28.5 263.33 96.67 308 158H187C136.33 99.33 99.17 32.83 75.5 -41.5C51.83 -115.83 40 -193.33 40 -274Z"},")":{"advance":339,"d":"M299 -274C299 -193.33 287.17 -115.83 263.5 -41.5C239.83 32.83 202.67 99.33 152 158H31C76.33 96.67 110.67 28.5 134 -46.5C157.33 -121.5 169 -197.67 169 -275C169 -354.33 157.17 -431.67 133.5 -507C109.83 -582.33 75.33 -651.33 30 -714H152C202.67 -653.33 239.83 -585.17 263.5 -509.5C287.17 -433.83 299 -355.33 299 -274Z"},"-":{"advance":320,"d":"M28 -206V-330H291V-206Z"}};

const hash = data => createHash('sha256').update(data).digest('hex');
const number = value => Number(value.toFixed(5)).toString();
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const slash = path => path.split(sep).join('/');

function usage() {
  return 'Usage: node scripts/export-brand.mjs [--output build/brand]';
}

function outputDirectory() {
  const args = process.argv.slice(2);
  if (!args.length) return resolve(root, 'build/brand');
  if (args.length !== 2 || args[0] !== '--output' || !args[1]) throw new Error(usage());
  const output = resolve(root, args[1]);
  if (output === root || output === sourceDir || output === resolve(root, 'build')) {
    throw new Error('Choose a dedicated export directory, such as build/brand.');
  }
  return output;
}

async function loadSharp() {
  const require = createRequire(import.meta.url);
  const override = process.env.DICTADUO_SHARP_MODULE;
  if (override && !isAbsolute(override)) {
    throw new Error('DICTADUO_SHARP_MODULE must be an absolute path to the sharp module.');
  }
  const candidates = override ? [override] : [resolve(root, '.build/brand-tools/node_modules/sharp'), 'sharp'];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const sharp = require(candidate);
      if (sharp.versions.sharp !== sharpVersion) {
        throw new Error(`Expected sharp ${sharpVersion}; found ${sharp.versions.sharp}.`);
      }
      sharp.cache(false);
      sharp.concurrency(1);
      return sharp;
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`The pinned raster renderer is unavailable.\nRun: ${installCommand}\n${errors.join('\n')}`);
}

function geometry(xml) {
  const values = xml.match(/\bviewBox="([^"]+)"/)?.[1].trim().split(/\s+/).map(Number);
  if (!values || values.length !== 4 || values.some(value => !Number.isFinite(value)) ||
      values[0] !== 0 || values[1] !== 0 || values[2] <= 0 || values[3] <= 0) {
    throw new Error('Expected an SVG viewBox beginning at 0 0.');
  }
  return { width: values[2], height: values[3] };
}

function sizedSvg(xml, width, height) {
  return xml.replace(/<svg\b([^>]*)>/, (_, attributes) => {
    const clean = attributes.replace(/\s+(?:width|height)="[^"]*"/g, '');
    return `<svg${clean} width="${width}" height="${height}">`;
  });
}

function icnsContainer(images) {
  const chunks = iconset.map(entry => {
    const image = images.get(entry.size);
    if (!image || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`ICNS ${entry.type} requires a PNG payload.`);
    }
    const header = Buffer.alloc(8);
    header.write(entry.type, 0, 4, 'ascii');
    header.writeUInt32BE(image.length + 8, 4);
    return Buffer.concat([header, image]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

// Text in the proof is constructed from explicit SVG paths, not system fonts.
function label(text, x, y, size, fill, tracking = 0.08) {
  let cursor = 0;
  const paths = [];
  for (const character of text.toUpperCase()) {
    const glyph = proofGlyphs[character];
    if (!glyph) throw new Error(`No outlined proof glyph for ${JSON.stringify(character)}.`);
    if (glyph.d) paths.push(`<path d="${glyph.d}" transform="translate(${number(cursor)} 0)"/>`);
    cursor += glyph.advance + tracking * 1000;
  }
  return `<g aria-label="${escape(text)}" fill="${fill}" transform="translate(${x} ${y}) scale(${number(size / 1000)})">${paths.join('')}</g>`;
}

function embeddedPng(buffer, x, y, width, height, title) {
  return `<image x="${x}" y="${y}" width="${width}" height="${height}" href="data:image/png;base64,${buffer.toString('base64')}"><title>${escape(title)}</title></image>`;
}

async function main() {
  const outputDir = outputDirectory();
  // This check comes before creating the output directory or exporting any file.
  const check = spawnSync(process.execPath, [resolve(root, 'scripts/generate-brand.mjs'), '--check'], {
    cwd: root, stdio: 'inherit',
  });
  if (check.error || check.status !== 0) {
    throw new Error('Vector/native outputs are stale or could not be checked. Run node scripts/generate-brand.mjs first.');
  }
  const sharp = await loadSharp();
  const config = JSON.parse(await readFile(resolve(sourceDir, 'brand.json'), 'utf8'));
  const existing = await stat(outputDir).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) {
    if (!existing.isDirectory()) throw new Error('The export destination is not a directory.');
    const entries = await readdir(outputDir);
    const oldMarker = await readFile(resolve(outputDir, '.dictaduo-brand-export'), 'utf8').catch(() => null);
    if (entries.length && oldMarker !== marker) {
      throw new Error('The export destination contains unrelated files. Choose a new directory with --output.');
    }
  }
  await mkdir(dirname(outputDir), { recursive: true });
  const stage = await mkdtemp(resolve(dirname(outputDir), `.${basename(outputDir)}-export-`));
  const files = [];
  const inputs = new Map();
  const pngs = new Map();
  const colors = config.colors;
  let published = false;

  async function input(name) {
    const data = await readFile(resolve(root, name));
    inputs.set(name, { path: name, bytes: data.length, sha256: hash(data) });
    return data;
  }

  async function save(name, data, details = {}) {
    if (name.includes('..') || isAbsolute(name)) throw new Error(`Unsafe output path: ${name}`);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const path = resolve(stage, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
    files.push({ path: name, bytes: buffer.length, sha256: hash(buffer), ...details });
    return buffer;
  }

  async function inspectPng(buffer, width, height, { monochrome, opaque = false } = {}) {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height || info.channels !== 4) {
      throw new Error(`Raster dimensions differ from requested ${width} × ${height}.`);
    }
    let minX = width, minY = height, maxX = -1, maxY = -1;
    let visible = 0, solid = 0, edgeMaxAlpha = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        const alpha = data[index + 3];
        if (!alpha) continue;
        visible++;
        if (alpha === 255) solid++;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          edgeMaxAlpha = Math.max(edgeMaxAlpha, alpha);
        }
        if (monochrome !== undefined &&
            (data[index] !== monochrome || data[index + 1] !== monochrome || data[index + 2] !== monochrome)) {
          throw new Error('A monochrome symbol contains colored or gray RGB pixels.');
        }
      }
    }
    if (!visible || !solid) throw new Error('An export has no solid visible artwork.');
    // Fractional insets may antialias into the outer pixel at 16/22/24/32 px.
    // Fully opaque outer-edge pixels would indicate clipped filled geometry.
    if (!opaque && (edgeMaxAlpha === 255 || visible === width * height)) {
      throw new Error('Artwork reaches the canvas edge without a transparent margin; inspect clipping.');
    }
    return {
      width, height, visiblePixels: visible, opaquePixels: solid,
      alphaBounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      edgeMaxAlpha, ...(monochrome !== undefined ? { monochrome: monochrome === 0 ? '#000000' : '#FFFFFF' } : {}),
    };
  }

  async function raster(xml, width, height, monochrome) {
    const rendered = sharp(Buffer.from(sizedSvg(xml, width, height))).ensureAlpha();
    if (monochrome === undefined) return rendered.png(pngOptions).toBuffer();
    // Preserve the rasterizer's alpha coverage while making all visible RGB
    // components exactly 0 or 255, including antialiased edge pixels.
    const { data, info } = await rendered.raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = monochrome;
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png(pngOptions).toBuffer();
  }

  async function png(name, xml, width, height, options = {}) {
    const buffer = await raster(xml, width, height, options.monochrome);
    const inspection = await inspectPng(buffer, width, height, options);
    await save(name, buffer, { kind: options.kind ?? 'png', ...inspection });
    pngs.set(name, buffer);
    return buffer;
  }

  try {
    await save('.dictaduo-brand-export', marker, { kind: 'export-marker' });
    const generatedNames = (await readdir(resolve(sourceDir, 'generated'))).filter(name => name.endsWith('.svg')).sort();
    const vectors = new Map();
    for (const name of generatedNames) {
      const data = await input(`Resources/Brand/generated/${name}`);
      vectors.set(name, data.toString('utf8'));
      await save(`svg/${name}`, data, { kind: 'svg' });
    }
    for (const name of ['brand.json', config.sources.mark, config.sources.tile, config.sources.wordmark, 'wordmark-editable.svg', 'native-renderer.swift', 'FONT-LICENSE.txt']) {
      await save(`sources/Resources/Brand/${name}`, await input(`Resources/Brand/${name}`), { kind: name.endsWith('.svg') ? 'svg-master' : 'brand-source' });
    }
    const brandGuide = await stat(resolve(sourceDir, 'README.md')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (brandGuide?.isFile()) {
      await save('sources/Resources/Brand/README.md', await input('Resources/Brand/README.md'), { kind: 'brand-guide' });
    }
    await save('FONT-LICENSE.txt', await input('Resources/Brand/FONT-LICENSE.txt'), { kind: 'font-license' });
    for (const name of ['generate-brand.mjs', 'export-brand.mjs', 'make-icon.template.swift', 'make-icon.swift']) {
      await save(`sources/scripts/${name}`, await input(`scripts/${name}`), { kind: 'reproduction-source' });
    }
    const optical = vectors.get('symbol-master.svg');
    if (!optical) throw new Error('Generated symbol-master.svg is missing.');
    const black = optical.replaceAll('currentColor', '#000000');
    const white = optical.replaceAll('currentColor', '#FFFFFF');
    await save('svg/symbol-monochrome.svg', black, { kind: 'svg' });
    await save('svg/symbol-monochrome-reversed.svg', white, { kind: 'svg' });
    const appIcon = vectors.get('app-icon.svg');
    if (!appIcon) throw new Error('Generated app-icon.svg is missing.');

    const appImages = new Map();
    for (const size of appSizes) {
      const image = await png(`png/app-icon/app-icon-${size}.png`, appIcon, size, size);
      appImages.set(size, image);
      await save(`linux/hicolor/${size}x${size}/apps/dictaduo.png`, image, { kind: 'linux-app-icon', width: size, height: size });
    }
    await save('linux/hicolor/scalable/apps/dictaduo.svg', appIcon, { kind: 'linux-app-icon-svg' });
    await save('linux/hicolor/scalable/status/dictaduo-symbolic.svg', black, { kind: 'linux-symbolic-svg' });
    await save('linux/hicolor/scalable/status/dictaduo-symbolic-light.svg', white, { kind: 'linux-symbolic-svg' });
    for (const size of symbolSizes) {
      await png(`png/symbol/black/symbol-${size}.png`, black, size, size, { monochrome: 0 });
      await png(`png/symbol/white/symbol-${size}.png`, white, size, size, { monochrome: 255 });
    }
    for (const size of proofSizes.filter(size => !appSizes.includes(size))) {
      await png(`proof/app-icon-${size}.png`, appIcon, size, size, { kind: 'proof-app-icon' });
    }
    for (const entry of iconset) {
      await save(`macOS/DictaDuo.iconset/${entry.name}`, appImages.get(entry.size), {
        kind: 'macos-iconset', width: entry.size, height: entry.size, points: entry.points, scale: entry.scale,
      });
    }
    await save('macOS/DictaDuo.icns', icnsContainer(appImages), {
      kind: 'icns', chunks: iconset.map(({ type, size, points, scale }) => ({ type, width: size, height: size, points, scale, encoding: 'PNG' })),
    });

    for (const [name, xml] of vectors) {
      if (name.startsWith('logo')) {
        const box = geometry(xml);
        for (const size of [128, 256, 512, 1024]) {
          await png(`png/logo/${name.replace('.svg', '')}-${size}.png`, xml, size, Math.round(size * box.height / box.width));
        }
      } else if (name.startsWith('lockup')) {
        const box = geometry(xml);
        for (const height of [128, 256, 512]) {
          await png(`png/lockup/${name.replace('.svg', '')}-${height}h.png`, xml, Math.round(box.width * height / box.height), height);
        }
      } else if (name.startsWith('wordmark')) {
        const box = geometry(xml);
        for (const height of [100, 200, 400]) {
          await png(`png/wordmark/${name.replace('.svg', '')}-${height}h.png`, xml, Math.round(box.width * height / box.height), height);
        }
      }
    }

    // This is a geometry model of the Linux tray adaptation, not a Qt screenshot.
    // It makes the small recording badge's relationship to the line reviewable.
    const opticalPaths = [...optical.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*>/g)].map(match => `<path d="${match[1]}"/>`).join('');
    const opticalBox = geometry(optical);
    function trayModel(size, primary, opposite) {
      const halo = Math.max(0.6, size / 32), margin = halo + 0.5;
      const scale = (size - margin * 2) / opticalBox.width;
      const use = (dx, dy, fill, opacity = 1) => `<g fill="${fill}" opacity="${opacity}" transform="translate(${number(margin + dx)} ${number(margin + dy)}) scale(${number(scale)})">${opticalPaths}</g>`;
      const layers = [];
      for (const dx of [-halo, 0, halo]) for (const dy of [-halo, 0, halo]) {
        if (dx || dy) layers.push(use(dx, dy, opposite, 0.85));
      }
      layers.push(use(0, 0, primary));
      const diameter = size * 0.34, stroke = Math.max(1, size / 16), inset = stroke / 2 + 0.5;
      const center = size - diameter / 2 - inset;
      layers.push(`<circle cx="${number(center)}" cy="${number(center)}" r="${number(diameter / 2)}" fill="#E5484D" stroke="#FFFFFF" stroke-width="${number(stroke)}"/>`);
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${layers.join('')}</svg>`;
    }
    for (const size of proofSizes) {
      for (const [theme, primary, opposite] of [['light', colors.ink, colors.ivory], ['dark', colors.ivory, colors.ink]]) {
        const xml = trayModel(size, primary, opposite);
        await png(`proof/tray-model-${theme}-${size}.png`, xml, size, size, { kind: 'tray-geometry-model' });
      }
    }

    const proofWidth = 1600, proofHeight = 1500;
    const proof = [
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${proofWidth}" height="${proofHeight}" viewBox="0 0 ${proofWidth} ${proofHeight}" role="img" aria-labelledby="proof-title proof-description">`,
      '<title id="proof-title">DictaDuo Inkflow Graphite production asset and pixel proof</title>',
      '<desc id="proof-description">Actual exported app icons and black/white symbols from the same original contour on light and dark surfaces. Enlarged samples use nearest-neighbor pixels. The recording row is a labeled SVG geometry model, not a native Qt capture. Labels are outlined and all images are embedded.</desc>',
      `<rect width="${proofWidth}" height="${proofHeight}" fill="#F4F3EE"/>`,
      `<rect width="${proofWidth}" height="390" fill="${colors.ink}"/>`,
      label('DICTADUO / INKFLOW / GRAPHITE', 64, 60, 18, colors.ivory),
      label('PRODUCTION ASSET PROOF', 930, 60, 15, colors.darkAccent),
      embeddedPng(appImages.get(256), 64, 98, 256, 256, '256 × 256 app icon'),
    ];
    const heroLockupXml = vectors.get('lockup-dark.svg');
    const heroBox = geometry(heroLockupXml);
    const heroWidth = 1056, heroHeight = Math.round(heroWidth * heroBox.height / heroBox.width);
    const hero = await raster(heroLockupXml, heroWidth, heroHeight);
    proof.push(embeddedPng(hero, 432, 137, heroWidth, heroHeight, 'Dark-context DictaDuo logo and outlined name'));
    proof.push(label('ACTUAL PIXELS', 64, 450, 23, colors.ink));
    proof.push(label('1 IMAGE PIXEL = 1 PROOF PIXEL AT 100%', 690, 448, 14, '#5C6471'));

    const panelY = 484, panelH = 294;
    for (const [theme, panelX, background, foreground, secondary] of [
      ['light', 64, '#FFFFFF', '#000000', '#656B75'],
      ['dark', 824, colors.ink, '#FFFFFF', colors.darkAccent],
    ]) {
      proof.push(`<rect x="${panelX}" y="${panelY}" width="712" height="${panelH}" rx="18" fill="${background}"/>`);
      proof.push(label(theme === 'light' ? 'LIGHT / BLACK SYMBOL' : 'DARK / WHITE SYMBOL', panelX + 28, panelY + 36, 15, foreground));
      const centers = proofSizes.map((_, index) => panelX + 222 + index * 104);
      for (let i = 0; i < proofSizes.length; i++) {
        proof.push(label(`${proofSizes[i]} PX`, centers[i] - 21, panelY + 70, 11, secondary, 0.025));
      }
      for (const [name, y, folder] of [
        ['SYMBOL', panelY + 108, `png/symbol/${theme === 'light' ? 'black' : 'white'}/symbol-`],
        ['APP ICON', panelY + 170, 'png/app-icon/app-icon-'],
        ['TRAY MODEL', panelY + 232, `proof/tray-model-${theme}-`],
      ]) {
        proof.push(label(name, panelX + 28, y + 5, 12, secondary, 0.025));
        for (let i = 0; i < proofSizes.length; i++) {
          const size = proofSizes[i];
          // 18 px is a menu-bar size, so the proof renders an additional app sample
          // directly from the same vector without adding a platform export slot.
          const buffer = pngs.get(`${folder}${size}.png`) ?? pngs.get(`proof/app-icon-${size}.png`);
          if (!buffer) throw new Error(`Missing pixel-proof source: ${folder}${size}.png`);
          proof.push(embeddedPng(buffer, centers[i] - size / 2, y - size / 2, size, size, `${name}, ${size} physical pixels, ${theme} context`));
        }
      }
    }
    proof.push(label('TRAY MODEL: SVG APPROXIMATION OF HALO + 34% RECORDING BADGE. NO NATIVE QT CAPTURE.', 64, 809, 11, '#656B75', 0.015));
    proof.push(label('PIXEL STRUCTURE', 64, 867, 23, colors.ink));
    proof.push(label('NEAREST NEIGHBOR / 12X / NO SMOOTHING', 840, 865, 14, '#5C6471'));
    for (const [theme, x, background, foreground] of [
      ['black', 64, '#FFFFFF', '#000000'], ['white', 824, colors.ink, '#FFFFFF'],
    ]) {
      proof.push(`<rect x="${x}" y="898" width="712" height="314" rx="18" fill="${background}"/>`);
      for (const [size, dx] of [[16, 46], [18, 368]]) {
        const buffer = pngs.get(`png/symbol/${theme}/symbol-${size}.png`);
        const enlarged = await sharp(buffer).resize(size * 12, size * 12, { kernel: 'nearest' }).png(pngOptions).toBuffer();
        const name = `proof/symbol-${theme}-${size}-nearest-12x.png`;
        await save(name, enlarged, { kind: 'nearest-neighbor-proof', width: size * 12, height: size * 12, sourceSize: size, zoom: 12 });
        proof.push(embeddedPng(enlarged, x + dx, 942, size * 12, size * 12, `${size} × ${size} symbol enlarged exactly 12× with nearest-neighbor pixels`));
        proof.push(label(`${size} PX / 12X`, x + dx, 1184, 13, foreground, 0.025));
      }
    }
    proof.push(label('PALETTE', 64, 1272, 21, colors.ink));
    for (const [index, [name, color]] of ['ink', 'gold', 'copper', 'ivory'].map(name => [name, colors[name]]).entries()) {
      const x = 64 + index * 376;
      proof.push(`<rect x="${x}" y="1298" width="344" height="70" rx="10" fill="${color}"/>`);
      const displayName = name === 'darkAccent' ? 'DARK ACCENT' : name.toUpperCase();
      proof.push(label(displayName, x, 1395, 12, colors.ink, 0.025));
      proof.push(label(color, x, 1420, 13, '#656B75', 0.025));
    }
    proof.push(label(`SHARP ${sharp.versions.sharp} / LIBRSVG ${sharp.versions.rsvg} / VECTOR MASTERS + PINNED RASTER EXPORTS`, 64, 1472, 11, '#656B75', 0.015));
    proof.push('</svg>\n');
    const proofSvg = proof.join('\n');
    await save('proof/production-proof.svg', proofSvg, { kind: 'self-contained-proof-svg', width: proofWidth, height: proofHeight });
    await png('proof/production-proof.png', proofSvg, proofWidth, proofHeight, { opaque: true, kind: 'production-proof' });

    const readme = `DictaDuo / Inkflow / Graphite — production asset pack\n\n` +
      `The editable and reproducible sources are in sources/. Color and monochrome SVG exports are\nin svg/. All wordmarks used for production are outlined and need no font.\n\n` +
      `App PNGs: png/app-icon/, sizes ${appSizes.join(', ')} px.\n` +
      `Same-contour black/white symbols: png/symbol/, sizes ${symbolSizes.join(', ')} px.\n` +
      `Logo, lockup, and standalone wordmark PNGs: png/logo/, png/lockup/, png/wordmark/.\n` +
      `Linux: linux/hicolor/ contains the application PNG/SVG and symbolic SVG slots.\n` +
      `macOS: macOS/DictaDuo.iconset contains the ten standard filenames.\nmacOS/DictaDuo.icns contains PNG chunks with the matching physical sizes and\n1x/2x type codes. It can be used without running iconutil.\n\n` +
      `Proof: proof/production-proof.png is a 1600x1500 pixel board. View at 100%\nto inspect actual physical pixels. Its SVG version is self-contained.\nEnlarged symbols preserve nearest-neighbor pixels. The recording row and\ntray-model files are SVG geometry approximations, not native Qt screenshots.\n\n` +
      `Regenerate from sources/ in this pack, or the DictaDuo repository root:\n  node scripts/generate-brand.mjs\n  ${installCommand}\n  node scripts/export-brand.mjs\n\n` +
      `Optional module routing: set DICTADUO_SHARP_MODULE to an absolute sharp module\npath. The required sharp version is ${sharpVersion}. Every run checks generated\nvectors before exporting, validates image dimensions/alpha/monochrome RGB,\nand records the renderer versions and source/output SHA-256 values.\n\n` +
      `No timestamps are included. PNG bytes are repeatable with the same sources\nand renderer. manifest.json lists asset hashes; SHA256SUMS also covers the\nmanifest itself. SHA256SUMS does not hash itself.\n\n` +
      `Font copyright and the full SIL Open Font License are in FONT-LICENSE.txt.\n`;
    await save('README.txt', readme, { kind: 'pack-instructions' });
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const manifest = {
      schemaVersion: 1,
      product: config.name,
      identity: config.identity,
      generator: 'scripts/export-brand.mjs',
      generatedVectorCheck: 'node scripts/generate-brand.mjs --check',
      dependency: { package: 'sharp', version: sharpVersion, installCommand },
      renderer: sharp.versions,
      runtime: { node: process.versions.node, platform: process.platform, architecture: process.arch },
      colors,
      appSizes,
      symbolSizes,
      markGeometry: { source: config.sources.mark, visibleBounds: config.icon.markBounds, smallSizePolicy: 'Uniform scale of the original contour; no independent redraw.' },
      icns: { encoding: 'PNG', chunks: iconset.map(({ type, size, points, scale }) => ({ type, size, points, scale })) },
      proof: {
        width: proofWidth, height: proofHeight, actualPixelSizes: proofSizes,
        enlargedSourceSizes: [16, 18], enlargement: 12, filter: 'nearest-neighbor',
        labels: 'Embedded Noto Sans Bold 2.015 outlines; no system fonts.',
        trayModel: 'SVG approximation of the Linux halo and 34% recording badge, not a native Qt capture.',
      },
      inputFiles: [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')),
      files,
      hashCoverage: 'files covers all pack files except manifest.json and SHA256SUMS; SHA256SUMS includes manifest.json and excludes itself.',
    };
    const manifestData = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(resolve(stage, 'manifest.json'), manifestData);
    const sums = [...files.map(file => ({ path: file.path, sha256: file.sha256 })), { path: 'manifest.json', sha256: hash(manifestData) }]
      .sort((a, b) => a.path.localeCompare(b.path, 'en'))
      .map(file => `${file.sha256}  ${file.path}\n`).join('');
    await writeFile(resolve(stage, 'SHA256SUMS'), sums);

    const backup = `${stage}-previous`;
    if (existing) await rename(outputDir, backup);
    try {
      await rename(stage, outputDir);
      published = true;
    } catch (error) {
      if (existing) await rename(backup, outputDir);
      throw error;
    }
    if (existing) await rm(backup, { recursive: true });
    console.log(`Exported ${files.length + 2} checked Inkflow Graphite files to ${slash(relative(root, outputDir)) || outputDir}.`);
    console.log(`Renderer: sharp ${sharp.versions.sharp}, librsvg ${sharp.versions.rsvg}, libvips ${sharp.versions.vips}.`);
    console.log('Pixel proof: proof/production-proof.png; hashes: manifest.json and SHA256SUMS.');
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Brand export failed: ${error.message}`);
  process.exitCode = 1;
});
