import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server } from "socket.io";
import { z } from "zod";
import { prisma } from "./lib/prisma.js";
const app = Fastify({ logger: true });
// PAS AAN ALS JE CODESANDBOX-URL WIJZIGT
const FRONTEND_ORIGIN = "https://q648dn.csb.app";
await app.register(cors, {
    origin: [FRONTEND_ORIGIN],
    methods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: false,
});
app.get("/health", async () => {
    return { ok: true };
});
async function getClassesPayload() {
    const classes = await prisma.schoolClass.findMany({
        orderBy: { name: "asc" },
        include: {
            students: { orderBy: { sortOrder: "asc" } },
            tasks: { orderBy: { sortOrder: "asc" } },
            taskStatuses: true,
        },
    });
    return classes.map((schoolClass) => ({
        id: schoolClass.id,
        name: schoolClass.name,
        studentPassword: schoolClass.studentPassword,
        teacherPassword: schoolClass.teacherPassword,
        students: schoolClass.students.map((s) => s.name),
        tasks: schoolClass.tasks.map((t) => t.name),
        grid: Object.fromEntries(schoolClass.students.map((student) => [
            student.name,
            Object.fromEntries(schoolClass.tasks.map((task) => {
                const match = schoolClass.taskStatuses.find((ts) => ts.studentId === student.id && ts.taskId === task.id);
                return [task.name, match?.status ?? "red"];
            })),
        ])),
    }));
}
app.get("/classes", async () => {
    return getClassesPayload();
});
const updateStatusSchema = z.object({
    className: z.string().min(1),
    studentName: z.string().min(1),
    taskName: z.string().min(1),
    status: z.enum(["red", "green", "orange"]),
});
const addClassSchema = z.object({
    name: z.string().min(1),
    studentPassword: z.string().min(1).default("1234"),
    teacherPassword: z.string().min(1).default("abcd"),
});
const renameClassSchema = z.object({
    oldName: z.string().min(1),
    newName: z.string().min(1),
});
const saveStudentsSchema = z.object({
    className: z.string().min(1),
    students: z.array(z.string().min(1)),
});
const saveTasksSchema = z.object({
    className: z.string().min(1),
    tasks: z.array(z.string().min(1)),
});
const savePasswordsSchema = z.object({
    className: z.string().min(1),
    studentPassword: z.string().min(1),
    teacherPassword: z.string().min(1),
});
let io;
app.patch("/status", async (request, reply) => {
    const parsed = updateStatusSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.status(400).send({
            error: "Ongeldige input",
            details: parsed.error.flatten(),
        });
    }
    const { className, studentName, taskName, status } = parsed.data;
    const schoolClass = await prisma.schoolClass.findUnique({
        where: { name: className },
        include: {
            students: true,
            tasks: true,
        },
    });
    if (!schoolClass) {
        return reply.status(404).send({ error: "Klas niet gevonden" });
    }
    const student = schoolClass.students.find((s) => s.name === studentName);
    if (!student) {
        return reply.status(404).send({ error: "Leerling niet gevonden" });
    }
    const task = schoolClass.tasks.find((t) => t.name === taskName);
    if (!task) {
        return reply.status(404).send({ error: "Taak niet gevonden" });
    }
    const updated = await prisma.taskStatus.upsert({
        where: {
            classId_studentId_taskId: {
                classId: schoolClass.id,
                studentId: student.id,
                taskId: task.id,
            },
        },
        update: { status },
        create: {
            classId: schoolClass.id,
            studentId: student.id,
            taskId: task.id,
            status,
        },
    });
    io.to(`class:${className}`).emit("status-updated", {
        className,
        studentName,
        taskName,
        status: updated.status,
    });
    return {
        ok: true,
        className,
        studentName,
        taskName,
        status: updated.status,
    };
});
app.post("/classes", async (request, reply) => {
    const parsed = addClassSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.status(400).send({ error: "Ongeldige input" });
    }
    const { name, studentPassword, teacherPassword } = parsed.data;
    const existing = await prisma.schoolClass.findUnique({
        where: { name },
    });
    if (existing) {
        return reply.status(409).send({ error: "Deze klas bestaat al" });
    }
    await prisma.schoolClass.create({
        data: {
            name,
            studentPassword,
            teacherPassword,
        },
    });
    io.emit("classes-changed");
    return { ok: true };
});
app.patch("/classes/rename", async (request, reply) => {
    const parsed = renameClassSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.status(400).send({ error: "Ongeldige input" });
    }
    const { oldName, newName } = parsed.data;
    const schoolClass = await prisma.schoolClass.findUnique({
        where: { name: oldName },
    });
    if (!schoolClass) {
        return reply.status(404).send({ error: "Klas niet gevonden" });
    }
    const existing = await prisma.schoolClass.findUnique({
        where: { name: newName },
    });
    if (existing) {
        return reply.status(409).send({ error: "Deze klasnaam bestaat al" });
    }
    await prisma.schoolClass.update({
        where: { name: oldName },
        data: { name: newName },
    });
    io.emit("classes-changed");
    return { ok: true };
});
app.put("/classes/students", async (request, reply) => {
    const parsed = saveStudentsSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.status(400).send({ error: "Ongeldige input" });
    }
    const { className, students } = parsed.data;
    const schoolClass = await prisma.schoolClass.findUnique({
        where: { name: className },
        include: {
            students: true,
            tasks: true,
            taskStatuses: true,
        },
    });
    if (!schoolClass) {
        return reply.status(404).send({ error: "Klas niet gevonden" });
    }
    const trimmedStudents = [...new Set(students.map((s) => s.trim()).filter(Boolean))];
    const existingStudents = schoolClass.students;
    const existingStudentNames = existingStudents.map((s) => s.name);
    const studentsToDelete = existingStudents.filter((student) => !trimmedStudents.includes(student.name));
    await prisma.$transaction(async (tx) => {
        for (const student of studentsToDelete) {
            await tx.taskStatus.deleteMany({
                where: {
                    classId: schoolClass.id,
                    studentId: student.id,
                },
            });
            await tx.student.delete({
                where: { id: student.id },
            });
        }
        for (const [index, studentName] of trimmedStudents.entries()) {
            const existingStudent = existingStudents.find((s) => s.name === studentName);
            if (existingStudent) {
                await tx.student.update({
                    where: { id: existingStudent.id },
                    data: { sortOrder: index },
                });
                continue;
            }
            const newStudent = await tx.student.create({
                data: {
                    name: studentName,
                    classId: schoolClass.id,
                    sortOrder: index,
                },
            });
            for (const task of schoolClass.tasks) {
                await tx.taskStatus.create({
                    data: {
                        classId: schoolClass.id,
                        studentId: newStudent.id,
                        taskId: task.id,
                        status: "red",
                    },
                });
            }
        }
    });
    io.emit("classes-changed");
    return { ok: true };
});
app.put("/classes/tasks", async (request, reply) => {
    const parsed = saveTasksSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.status(400).send({ error: "Ongeldige input" });
    }
    const { className, tasks } = parsed.data;
    const schoolClass = await prisma.schoolClass.findUnique({
        where: { name: className },
        include: {
            students: true,
            tasks: true,
            taskStatuses: true,
        },
    });
    if (!schoolClass) {
        return reply.status(404).send({ error: "Klas niet gevonden" });
    }
    const trimmedTasks = [...new Set(tasks.map((t) => t.trim()).filter(Boolean))];
    const existingTasks = schoolClass.tasks;
    const existingTaskNames = existingTasks.map((t) => t.name);
    const tasksToDelete = existingTasks.filter((task) => !trimmedTasks.includes(task.name));
    await prisma.$transaction(async (tx) => {
        for (const task of tasksToDelete) {
            await tx.taskStatus.deleteMany({
                where: {
                    classId: schoolClass.id,
                    taskId: task.id,
                },
            });
            await tx.task.delete({
                where: { id: task.id },
            });
        }
        for (const [index, taskName] of trimmedTasks.entries()) {
            const existingTask = existingTasks.find((t) => t.name === taskName);
            if (existingTask) {
                await tx.task.update({
                    where: { id: existingTask.id },
                    data: { sortOrder: index },
                });
                continue;
            }
            const newTask = await tx.task.create({
                data: {
                    name: taskName,
                    classId: schoolClass.id,
                    sortOrder: index,
                },
            });
            for (const student of schoolClass.students) {
                await tx.taskStatus.create({
                    data: {
                        classId: schoolClass.id,
                        studentId: student.id,
                        taskId: newTask.id,
                        status: "red",
                    },
                });
            }
        }
    });
    io.emit("classes-changed");
    return { ok: true };
});
app.put("/classes/passwords", async (request, reply) => {
    const parsed = savePasswordsSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.status(400).send({ error: "Ongeldige input" });
    }
    const { className, studentPassword, teacherPassword } = parsed.data;
    const schoolClass = await prisma.schoolClass.findUnique({
        where: { name: className },
    });
    if (!schoolClass) {
        return reply.status(404).send({ error: "Klas niet gevonden" });
    }
    await prisma.schoolClass.update({
        where: { name: className },
        data: {
            studentPassword,
            teacherPassword,
        },
    });
    io.emit("classes-changed");
    return { ok: true };
});
const port = Number(process.env.PORT || 3001);
await app.ready();
io = new Server(app.server, {
    cors: {
        origin: [FRONTEND_ORIGIN],
        methods: ["GET", "POST", "PATCH", "PUT"],
        credentials: false,
    },
});
io.on("connection", (socket) => {
    socket.on("join-class", (className) => {
        socket.join(`class:${className}`);
    });
    socket.on("leave-class", (className) => {
        socket.leave(`class:${className}`);
    });
});
await app.listen({
    port,
    host: "0.0.0.0",
});
app.log.info(`NU4P backend draait op http://localhost:${port}`);
