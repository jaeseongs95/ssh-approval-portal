// Desktop adapter: RFB protocol and PNG frames (javax.imageio), managed Linux X11 sessions, RDP input wire. The classes that start xfreerdp3 and Xvnc are the
// only ones the process rule (ArchitectureRulesTest, rule A-PROCESS) will list; Java has no replacement for them.
dependencies {
    api(project(":portal-app"))
}
