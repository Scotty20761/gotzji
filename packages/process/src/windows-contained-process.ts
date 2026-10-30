export const windowsContainedProcessSource = String.raw`using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class ContainedProcess : IDisposable {
 const uint CreateSuspended=4, CreateNoWindow=0x08000000, KillOnJobClose=0x2000, StartUseStdHandles=0x100;
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinimumWorkingSet,MaximumWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint Priority,Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long UserTime,KernelTime,PeriodUserTime,PeriodKernelTime; public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public uint Size; public string Reserved,Desktop,Title; public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedPointer,Input,Output,Error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref ExtendedLimits info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int infoClass,out Accounting info,uint size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
 IntPtr job,process;
 bool disposed;
 public uint ProcessId { get; private set; }
 private ContainedProcess() {}
 public static ContainedProcess Start(string executable,string[] arguments,string cwd) { return Start(executable,arguments,cwd,false); }
 public static ContainedProcess Start(string executable,string[] arguments,string cwd,bool verbatim) {
  if(!Path.IsPathRooted(executable)||!Path.IsPathRooted(cwd))throw new IOException("CONTAINMENT_ABSOLUTE_PATH_REQUIRED");
  var instance=new ContainedProcess();
  ProcessInfo child=new ProcessInfo();
  IntPtr input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero;
  try {
   instance.job=CreateJobObject(IntPtr.Zero,null);
   if(instance.job==IntPtr.Zero)throw new IOException("CONTAINMENT_JOB_UNAVAILABLE");
   var limits=new ExtendedLimits(); limits.Basic.Flags=KillOnJobClose;
   if(!SetInformationJobObject(instance.job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))))throw new IOException("CONTAINMENT_LIMITS_UNAVAILABLE");
   var command=new StringBuilder(Quote(executable));
   foreach(var argument in arguments) {
    if(argument.IndexOf('\0')>=0)throw new IOException("CONTAINMENT_INVALID_ARGUMENT");
    command.Append(" ").Append(verbatim?argument:Quote(argument));
   }
   input=InheritStandardHandle(-10);output=InheritStandardHandle(-11);error=InheritStandardHandle(-12);
   var startup=new Startup{Size=(uint)Marshal.SizeOf(typeof(Startup)),Flags=StartUseStdHandles,Input=input,Output=output,Error=error};
   if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,CreateSuspended|CreateNoWindow,IntPtr.Zero,cwd,ref startup,out child))throw new IOException("CONTAINMENT_CREATE_FAILED");
   instance.process=child.Process; instance.ProcessId=child.ProcessId;
   if(!AssignProcessToJobObject(instance.job,child.Process))throw new IOException("CONTAINMENT_ASSIGN_FAILED");
   if(ResumeThread(child.Thread)==UInt32.MaxValue)throw new IOException("CONTAINMENT_RESUME_FAILED");
   CloseHandle(child.Thread); child.Thread=IntPtr.Zero;
   return instance;
  } catch {
   if(child.Process!=IntPtr.Zero){TerminateProcess(child.Process,1);WaitForSingleObject(child.Process,10000);}
   if(child.Thread!=IntPtr.Zero)CloseHandle(child.Thread);
   instance.Dispose();throw;
  } finally {
   if(input!=IntPtr.Zero)CloseHandle(input);
   if(output!=IntPtr.Zero)CloseHandle(output);
   if(error!=IntPtr.Zero)CloseHandle(error);
  }
 }
 static IntPtr InheritStandardHandle(int kind) {
  var original=GetStdHandle(kind);
  if(original==IntPtr.Zero||original==new IntPtr(-1))return IntPtr.Zero;
  IntPtr inherited;
  if(!DuplicateHandle(new IntPtr(-1),original,new IntPtr(-1),out inherited,0,true,2))throw new IOException("CONTAINMENT_STDIO_UNAVAILABLE");
  return inherited;
 }
 public uint ActiveProcesses {
  get {
   if(disposed)throw new ObjectDisposedException("ContainedProcess");
   Accounting info;
   if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new IOException("CONTAINMENT_UNVERIFIED");
   return info.ActiveProcesses;
  }
 }
 public int WaitForExit(int timeoutMilliseconds) {
  var end=DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
  while(ActiveProcesses!=0) {
   if(DateTime.UtcNow>=end)throw new TimeoutException("CONTAINMENT_TIMEOUT");
   Thread.Sleep(10);
  }
  uint code;
  if(!GetExitCodeProcess(process,out code)||code==259)throw new IOException("CONTAINMENT_EXIT_UNVERIFIED");
  return unchecked((int)code);
 }
 public void Cancel() {
  if(disposed)throw new ObjectDisposedException("ContainedProcess");
  if(!TerminateJobObject(job,1))throw new IOException("CONTAINMENT_CANCEL_UNVERIFIED");
  WaitForExit(10000);
 }
 public void Dispose() {
  if(disposed)return;
  if(job!=IntPtr.Zero)CloseHandle(job);
  if(process!=IntPtr.Zero)CloseHandle(process);
  disposed=true;
 }
 static string Quote(string value) {
  if(value.IndexOf('\0')>=0)throw new IOException("CONTAINMENT_INVALID_ARGUMENT");
  var result=new StringBuilder("\""); int slashes=0;
  foreach(char c in value) {
   if(c=='\\'){slashes++;continue;}
   if(c=='"'){result.Append('\\',slashes*2+1).Append(c);slashes=0;continue;}
   result.Append('\\',slashes).Append(c);slashes=0;
  }
  return result.Append('\\',slashes*2).Append('"').ToString();
 }
}
`;
