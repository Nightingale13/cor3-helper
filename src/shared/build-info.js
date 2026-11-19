// A reload can leave the game's MAIN-world script from an older build running.
// Keep the build identity in diagnostic exports to distinguish those sessions.
export const BUILD_ID = typeof __COR3_BUILD_ID__ === 'string' ? __COR3_BUILD_ID__ : 'development';
