// ConsoleStream의 선행 대기를 거치지 않고 실제 파이프 종료(109)만 0으로 돌려준다.
// 길이가 0인 쓰기도 ReadFile을 성공시킬 수 있으므로 성공한 0바이트 읽기는 반복한다.
// 표준 핸들은 프로세스 소유이며 비소유 SafeFileHandle로 수명을 보존한다.
const source = 'using System;using System.IO;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;namespace SshApproval{public static class Stdin{[DllImport("kernel32.dll")]static extern IntPtr GetStdHandle(int n);[DllImport("kernel32.dll",SetLastError=true)]static extern bool ReadFile(SafeFileHandle h,[Out]byte[] b,uint c,out uint r,IntPtr o);static readonly SafeFileHandle h=new SafeFileHandle(GetStdHandle(-10),false);public static int Read(byte[] b,int o,int c){if(c<1||o<0||c>b.Length-o)throw new ArgumentOutOfRangeException();byte[] t=new byte[c];uint r;for(;;){bool ok=ReadFile(h,t,(uint)c,out r,IntPtr.Zero);int e=Marshal.GetLastWin32Error();if(!ok){if(e==109)return 0;throw new System.ComponentModel.Win32Exception(e);}if(r>0){Buffer.BlockCopy(t,0,b,o,(int)r);return (int)r;}}}}}';

// 준비는 자식 범위에서만 실행하여 호출자의 모듈 탐색 정책과 명령 이름을 보존한다.
// 삽입 뒤 [SshApproval.Stdin]::Read(byte[], offset, count>0)를 호출한다.
// 0은 실제 EOF, 그 밖의 읽기 오류는 예외다. 호출자는 원래 상한과 검증을 유지한다.
export const WINDOWS_STDIN_READER = `&{Microsoft.PowerShell.Core\\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -Scope Local -Force -ErrorAction Stop;Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition '${source}' -ErrorAction Stop};`;
