import { prisma } from "./lib/prisma.js";
async function main() {
    const existing = await prisma.schoolClass.findUnique({
        where: { name: "Klas A" },
    });
    if (existing) {
        console.log("Klas A bestaat al");
        return;
    }
    const schoolClass = await prisma.schoolClass.create({
        data: {
            name: "Klas A",
            studentPassword: "1234",
            teacherPassword: "abcd",
        },
    });
    const emma = await prisma.student.create({
        data: { name: "Emma", classId: schoolClass.id },
    });
    const liam = await prisma.student.create({
        data: { name: "Liam", classId: schoolClass.id },
    });
    const lezen = await prisma.task.create({
        data: { name: "Lezen", classId: schoolClass.id },
    });
    const rekenen = await prisma.task.create({
        data: { name: "Rekenen", classId: schoolClass.id },
    });
    const combos = [
        [emma.id, lezen.id],
        [emma.id, rekenen.id],
        [liam.id, lezen.id],
        [liam.id, rekenen.id],
    ];
    for (const [studentId, taskId] of combos) {
        await prisma.taskStatus.create({
            data: {
                classId: schoolClass.id,
                studentId,
                taskId,
                status: "red",
            },
        });
    }
    console.log("Seed klaar");
}
main()
    .catch((err) => {
    console.error(err);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
