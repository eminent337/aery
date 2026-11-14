export class ParkGuard {
	public canPark(memberName: string): boolean {
		return memberName.toLowerCase() !== "coordinator";
	}
}
